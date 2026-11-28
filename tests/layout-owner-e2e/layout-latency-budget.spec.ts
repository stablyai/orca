import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { waitForSessionReady } from './helpers/store'
import { LAYOUT_OWNER_SWITCH_ON } from './helpers/layout-owner-build'
import { percentile, timeLayoutAction } from './helpers/layout-action-latency'

// Lane budget: with the main-owned layout path on, new tab, split and tab switch keep their p95 within the
// switch-off p95 plus one frame. A switch-off run prints the p95s the baseline file records, per
// platform and timing (drawn, or committed where the hidden window draws no frames).

const SAMPLES = 20
const WARMUP = 3
const FRAME_MS = 16
const BUDGETED = ['newTab', 'split', 'tabSwitch'] as const
type Budgeted = (typeof BUDGETED)[number]
type Timing = 'drawn' | 'committed'

type Baseline = { timing: Timing } & Record<Budgeted, number>
const baselines = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests', 'layout-owner-e2e', 'layout-latency-baselines.json'),
    'utf8'
  )
).switchOffP95Ms as Record<string, Baseline>

test('new tab, split and tab switch stay within the switch-off p95 plus a frame', async (// oxlint-disable-next-line no-empty-pattern -- owns its launch
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  // Production: development turns on per-frame layout checks that release builds skip.
  const session = createRestartSession(testInfo, { NODE_ENV: 'production' })
  const { app, page } = await session.launch()
  try {
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    // Keep a hidden window drawing where the platform allows; time the committed change where not.
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false)
      }
    })
    const frameMs = await page.evaluate(async () => {
      const t0 = performance.now()
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      return (performance.now() - t0) / 5
    })
    const timing: Timing = frameMs < 100 ? 'drawn' : 'committed'
    const options = { drawn: timing === 'drawn' }

    const samples: Record<Budgeted, number[]> = { newTab: [], split: [], tabSwitch: [] }
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      const newTab = await timeLayoutAction(page, 'newTab', null, options)
      await page.keyboard.press('Escape')
      const split = await timeLayoutAction(page, 'split', null, options)
      await timeLayoutAction(page, 'closePane', null, options)
      const tabIds = await page.evaluate(
        (id) =>
          (window.__store!.getState().tabsByWorktree[id] ?? [])
            .map((tab: { id: string }) => tab.id)
            .slice(0, 2),
        worktreeId
      )
      const tabSwitch = await timeLayoutAction(page, 'tabSwitch', tabIds, options)
      // Keep the tab count bounded: close the tab this round made.
      await page.evaluate((id) => {
        const s = window.__store!.getState()
        const tabs = s.tabsByWorktree[id] ?? []
        if (tabs.length > 2) {
          s.closeTab(tabs.at(-1)!.id)
        }
      }, worktreeId)
      if (i >= WARMUP) {
        samples.newTab.push(newTab)
        samples.split.push(split)
        samples.tabSwitch.push(tabSwitch)
      }
    }

    const p95 = Object.fromEntries(
      BUDGETED.map((action) => [action, +percentile(samples[action], 95).toFixed(1)])
    ) as Record<Budgeted, number>
    const layoutOwner = LAYOUT_OWNER_SWITCH_ON ? 'on' : 'off'
    const report = { layoutOwner, platform: process.platform, timing, p95 }
    testInfo.annotations.push({ type: 'layout-latency-p95', description: JSON.stringify(report) })
    console.log(`layout-latency-p95 ${JSON.stringify(report)}`)

    const baseline = baselines[process.platform]
    test.skip(
      !LAYOUT_OWNER_SWITCH_ON || !baseline,
      'the budget applies to the main-owned layout path'
    )
    expect(timing, 'timed the way the baseline was').toBe(baseline.timing)
    for (const action of BUDGETED) {
      expect
        .soft(p95[action], `${action} p95 vs switch-off ${baseline[action]} ms plus a frame`)
        .toBeLessThan(baseline[action] + FRAME_MS)
    }
  } finally {
    await session.dispose(app)
  }
})
