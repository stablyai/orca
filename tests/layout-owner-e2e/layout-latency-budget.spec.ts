import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { LAYOUT_OWNER_BUILD } from './helpers/layout-owner-build'
import { percentile, timeLayoutAction } from './helpers/layout-action-latency'

// Lane budget: on the layout-owner build, new tab, split and tab switch keep their input-to-drawn
// p95 within the switch-off p95 plus one frame. A switch-off run reports the p95s that the
// baseline file records, per platform.

const SAMPLES = 20
const WARMUP = 3
const FRAME_MS = 16
const BUDGETED = ['newTab', 'split', 'tabSwitch'] as const
type Budgeted = (typeof BUDGETED)[number]

type Baselines = Record<string, Record<Budgeted, number>>
const baselines = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests', 'layout-owner-e2e', 'layout-latency-baselines.json'),
    'utf8'
  )
).switchOffP95Ms as Baselines

test('new tab, split and tab switch stay within the switch-off p95 plus a frame', async ({
  orcaPage: page
}, testInfo) => {
  test.setTimeout(300_000)
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)

  const samples: Record<Budgeted, number[]> = { newTab: [], split: [], tabSwitch: [] }
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const newTab = await timeLayoutAction(page, 'newTab')
    await page.keyboard.press('Escape')
    const split = await timeLayoutAction(page, 'split')
    await timeLayoutAction(page, 'closePane')
    const tabIds = await page.evaluate(
      (id) =>
        (window.__store!.getState().tabsByWorktree[id] ?? [])
          .map((tab: { id: string }) => tab.id)
          .slice(0, 2),
      worktreeId
    )
    const tabSwitch = await timeLayoutAction(page, 'tabSwitch', tabIds)
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
  const report = { build: LAYOUT_OWNER_BUILD ? 'on' : 'off', platform: process.platform, p95 }
  testInfo.annotations.push({ type: 'layout-latency-p95', description: JSON.stringify(report) })
  console.log(`layout-latency-p95 ${JSON.stringify(report)}`)

  const baseline = baselines[process.platform]
  test.skip(!LAYOUT_OWNER_BUILD || !baseline, 'budget applies to the layout-owner build')
  for (const action of BUDGETED) {
    expect
      .soft(p95[action], `${action} p95 vs switch-off ${baseline[action]} ms plus a frame`)
      .toBeLessThan(baseline[action] + FRAME_MS)
  }
})
