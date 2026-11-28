// On-vs-off latency census for the layout owner: input-to-drawn time per layout action, main's
// event-loop delay, and relaunch time, written as JSON. Manual: run it on an on and an off build in
// turn (ORCA_LAYOUT_LATENCY_CENSUS=1); the lane runs layout-latency-budget.spec.ts instead.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { LAYOUT_OWNER_BUILD } from './helpers/layout-owner-build'
import { timeLayoutAction as timed } from './helpers/layout-action-latency'

const env = process.env
const OUT = env.ORCA_LAYOUT_LATENCY_OUT ?? path.resolve('layout-latency-census')
const SAMPLES = Number(env.ORCA_LAYOUT_LATENCY_SAMPLES ?? 13)
const WARMUP = 3
const RELAUNCHES = Number(env.ORCA_LAYOUT_LATENCY_RELAUNCHES ?? 10)
/** A repo with many git worktrees, for the long-used-profile case; each becomes a workspace. */
const FLEET_REPO = env.ORCA_LAYOUT_LATENCY_FLEET_REPO
/** How many workspaces get a saved terminal tab, as a long-used profile has. */
const SEEDED_TAB_WORKSPACES = Number(env.ORCA_LAYOUT_LATENCY_TAB_WORKSPACES ?? 0)

test.skip(!env.ORCA_LAYOUT_LATENCY_CENSUS, 'manual census; set ORCA_LAYOUT_LATENCY_CENSUS=1')

test('layout latency per action', async (// oxlint-disable-next-line no-empty-pattern -- owns its launches
{}, testInfo) => {
  test.setTimeout(3_600_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  const session = createRestartSession(testInfo)
  const build = LAYOUT_OWNER_BUILD ? 'on' : 'off'
  const samples: Record<string, number[]> = {}
  let launchMs = 0
  let worktreeCount = 0
  let seedMs = 0
  let loop: unknown = null
  const errors = new Set<string>()
  const loadStart = loadavg()
  const t = Date.now()
  let launched = await session.launch()
  try {
    const worktreeId = await attachRepoAndOpenTerminal(launched.page, repoPath)
    launchMs = Date.now() - t
    let page = launched.page
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    if (FLEET_REPO) {
      await page.evaluate(async (fleet) => {
        const added = await window.api.repos.add({ path: fleet })
        if ('error' in added) {
          throw new Error(added.error)
        }
        await window.__store!.getState().fetchRepos({ runtimeEnvironmentId: null })
        await window.__store!.getState().updateRepo(added.repo.id, {
          externalWorktreeVisibility: 'show'
        })
      }, FLEET_REPO)
    }
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const s = window.__store!.getState()
            for (const repo of s.repos) {
              await s.fetchWorktrees(repo.id)
            }
            const all = Object.values(window.__store!.getState().worktreesByRepo).flat()
            return all.length
          }),
        { timeout: 60_000 }
      )
      .toBeGreaterThanOrEqual(Math.max(2, SEEDED_TAB_WORKSPACES + 1))
    const worktrees = await page.evaluate(() =>
      Object.values(window.__store!.getState().worktreesByRepo)
        .flat()
        .map((w: { id: string }) => w.id)
    )
    if (SEEDED_TAB_WORKSPACES > 0) {
      // Give many workspaces a saved terminal tab, as a long-used profile has.
      await page.evaluate(
        ({ ids, n }) => {
          const s = window.__store!.getState()
          for (const id of ids.slice(0, n)) {
            s.createTab(id, undefined, undefined, { activate: false })
          }
        },
        { ids: worktrees.filter((id) => id !== worktreeId), n: SEEDED_TAB_WORKSPACES }
      )
      // Until every seeded tab is in the store, then let main's writes settle.
      const seed0 = Date.now()
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                Object.values(window.__store!.getState().tabsByWorktree).filter(
                  (tabs) => (tabs?.length ?? 0) > 0
                ).length
            ),
          { timeout: 600_000 }
        )
        .toBeGreaterThanOrEqual(SEEDED_TAB_WORKSPACES)
      seedMs = Date.now() - seed0
      await page.waitForTimeout(5_000)
      // Measure a profile loaded from disk, as a long-used one is (not one built live this run).
      await session.close(launched.app)
      launched = await session.launch()
      page = launched.page
      await waitForSessionReady(page)
      await page.evaluate((id) => window.__store!.getState().setActiveWorktree(id), worktreeId)
      await waitForActiveTerminalManager(page, 60_000)
    }
    worktreeCount = worktrees.length
    const other = worktrees.find((id) => id !== worktreeId)!
    // Two tabs in the measured workspace, and one in the other workspace for switches.
    await page.getByRole('button', { name: 'New tab' }).click({ force: true })
    await page
      .getByRole('button', { name: /New Terminal/i })
      .first()
      .click()
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0,
          worktreeId
        )
      )
      .toBeGreaterThanOrEqual(2)
    // Plain text opens in the code editor (markdown opens in the rich editor).
    const file = path.join(repoPath, 'latency-open.txt')
    const firstLine = 'latency open probe'
    writeFileSync(file, `${firstLine}\n`)
    // Give the other workspace a drawn terminal once, so switching into it shows one.
    await page.evaluate((id) => window.__store!.getState().setActiveWorktree(id), other)
    await page.evaluate((id) => {
      const s = window.__store!.getState()
      if (!(s.tabsByWorktree[id] ?? []).length) {
        s.createTab(id)
      }
    }, other)
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('.xterm').length), {
        timeout: 30_000
      })
      .toBeGreaterThan(0)
    await page.evaluate((id) => window.__store!.getState().setActiveWorktree(id), worktreeId)
    await page.waitForTimeout(500)
    const record = (name: string, ms: number, at: number) => {
      if (at >= WARMUP) {
        ;(samples[name] ??= []).push(+ms.toFixed(2))
      }
    }
    // Main-process event-loop delay over the timed actions.
    await launched.app.evaluate(() => {
      const g = globalThis as unknown as { __censusLoop?: unknown; process: NodeJS.Process }
      const req = (g.process as unknown as { mainModule?: NodeRequire }).mainModule?.require
      const perf = req ? req('node:perf_hooks') : null
      if (perf) {
        const h = perf.monitorEventLoopDelay({ resolution: 5 })
        h.enable()
        g.__censusLoop = h
      }
    })
    for (let i = 0; i < SAMPLES; i++) {
      record('newTab', await timed(page, 'newTab', null), i)
      await page.keyboard.press('Escape').catch(() => {})
      record('split', await timed(page, 'split', null), i)
      await page.waitForTimeout(150)
      record('closePane', await timed(page, 'closePane', null), i)
      const tabIds = await page.evaluate(
        (id) =>
          (window.__store!.getState().tabsByWorktree[id] ?? [])
            .map((tab: { id: string }) => tab.id)
            .slice(0, 2),
        worktreeId
      )
      record('tabSwitch', await timed(page, 'tabSwitch', tabIds), i)
      record(
        'reorder',
        await timed(page, 'reorder', null).catch((e: Error) => {
          errors.add(String(e.message).slice(0, 200))
          return Number.NaN
        }),
        i
      )
      record('rename', await timed(page, 'rename', null), i)
      record(
        'openFile',
        await timed(page, 'openFile', { filePath: file, firstLine }).catch((e: Error) => {
          errors.add(String(e.message).slice(0, 200))
          return Number.NaN
        }),
        i
      )
      await page.evaluate((filePath) => {
        const s = window.__store!.getState()
        for (const f of s.openFiles.filter((f: { filePath: string }) => f.filePath === filePath)) {
          s.closeFile(f.id)
        }
      }, file)
      await page.evaluate((id) => window.__store!.getState().setActiveWorktree(id), worktreeId)
      await page.waitForTimeout(100)
      // Workspace switch away and back; time the switch into a workspace with a drawn terminal.
      record(
        'workspaceSwitch',
        await timed(page, 'workspaceSwitch', [worktreeId, other]).catch((e: Error) => {
          errors.add(String(e.message).slice(0, 200))
          return Number.NaN
        }),
        i
      )
      await page.evaluate((id) => window.__store!.getState().setActiveWorktree(id), worktreeId)
      await page.waitForTimeout(150)
      // Keep the tab count bounded: close the tab newTab made.
      await page.evaluate((id) => {
        const s = window.__store!.getState()
        const tabs = s.tabsByWorktree[id] ?? []
        if (tabs.length > 3) {
          s.closeTab?.(tabs.at(-1)!.id)
        }
      }, worktreeId)
      await page.waitForTimeout(150)
    }
    loop = await launched.app.evaluate(() => {
      const h = (
        globalThis as unknown as {
          __censusLoop?: { percentile(p: number): number; max: number; mean: number }
        }
      ).__censusLoop
      return h
        ? { p50Ms: h.percentile(50) / 1e6, p99Ms: h.percentile(99) / 1e6, maxMs: h.max / 1e6 }
        : null
    })
    // Relaunch: time from launch to a drawn restored terminal; the first relaunch is a warm-up.
    for (let i = 0; i <= RELAUNCHES; i++) {
      await session.close(launched.app)
      const r0 = Date.now()
      launched = await session.launch()
      await waitForSessionReady(launched.page)
      await expect
        .poll(
          () =>
            launched.page.evaluate(() =>
              [...(window.__paneManagers?.values() ?? [])].some((m) => m.getPanes().length > 0)
            ),
          { timeout: 60_000, intervals: [16] }
        )
        .toBe(true)
      if (i > 0) {
        ;(samples.relaunch ??= []).push(Date.now() - r0)
      }
    }
  } finally {
    mkdirSync(OUT, { recursive: true })
    const file = path.join(
      OUT,
      `${env.ORCA_LAYOUT_LATENCY_TAG ?? 'run'}-${build}-${Date.now()}.json`
    )
    writeFileSync(
      file,
      JSON.stringify(
        {
          build,
          workspaces: worktreeCount,
          seededTabWorkspaces: SEEDED_TAB_WORKSPACES,
          launchMs,
          seedMs,
          loop,
          loadStart,
          loadEnd: loadavg(),
          samples,
          errors: [...errors]
        },
        null,
        1
      )
    )
    await session.dispose(launched.app)
  }
})
