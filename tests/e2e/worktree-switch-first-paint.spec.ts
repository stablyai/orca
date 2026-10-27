import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { loadWorktreesUntilPathsPresent } from './helpers/worktree-registration'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

// Measure cold persisted-tab reveal beyond click-task responsiveness and eventual buffer convergence.
// Reload between rounds at production parking timings: tabs exist in session but never mounted, matching worktree counts beyond hot retention.

// Use three tabs to match the motivating 449-worktree profile’s median 2–3 tabs.
const TABS_PER_WORKTREE = Number(process.env.ORCA_SWITCH_TABS ?? '3')
const SCROLLBACK_LINES = 1_500
// Budget: a switch has to look instant. Anything over this reads as a stall.
const FIRST_PAINT_BUDGET_MS = Number(process.env.ORCA_SWITCH_BUDGET_MS ?? '250')
// Repeat because single cold-reveal noise is tens of milliseconds, the same scale as the change.
const SWITCH_SAMPLE_COUNT = Number(process.env.ORCA_SWITCH_ROUNDS ?? '5')

type SwitchSample = {
  activationMs: number | null
  paneMountedMs: number | null
  contentRestoredMs: number | null
  maxFrameGapMs: number
  longTaskTotalMs: number
  worstLongTaskMs: number
  mountedAtActivation: number
  settledPaneManagers: number
  settledPanes: number
  settledWebglContexts: number
}

type SwitchPaintProbe = {
  t0: number
  activationMs: number | null
  paneMountedMs: number | null
  contentRestoredMs: number | null
  frames: number[]
  longTasks: number[]
  mountedAtActivation: number
  stop: () => void
}

declare global {
  var __switchPaintProbe: SwitchPaintProbe | undefined
}

async function ensureTabs(page: Page, worktreeId: string, marker: string): Promise<string[]> {
  await switchToWorktree(page, worktreeId)
  await ensureTerminalVisible(page)
  const tabIds: string[] = []
  for (let index = 0; index < TABS_PER_WORKTREE; index += 1) {
    const tabId = await page.evaluate(
      ({ id, wanted }) => {
        const state = window.__store!.getState()
        const existing = state.tabsByWorktree[id] ?? []
        const reuse = existing[wanted]
        const tab = reuse ?? state.createTab(id, undefined, undefined, { activate: true })
        state.setActiveTab(tab.id)
        state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
        return tab.id
      },
      { id: worktreeId, wanted: index }
    )
    await waitForActiveTerminalManager(page, 30_000)
    const ptyId = await waitForActivePanePtyId(page, 30_000)
    const label = `${marker}_T${index}`
    await execInTerminal(
      page,
      ptyId,
      `for i in $(seq 1 ${SCROLLBACK_LINES}); do echo "${label}_$i ${'y'.repeat(48)}"; done; echo ${label}_READY`
    )
    await waitForTerminalOutput(page, `${label}_READY`, 60_000)
    tabIds.push(tabId)
  }
  return tabIds
}

async function waitForUnmountedTabs(page: Page, tabIds: readonly string[]): Promise<boolean> {
  return expect
    .poll(
      () =>
        page.evaluate((ids) => ids.every((id) => window.__paneManagers?.has(id) !== true), tabIds),
      { timeout: 20_000, message: 'switch target still had mounted panes' }
    )
    .toBe(true)
    .then(
      () => true,
      () => false
    )
}

/** Tabs with a mounted pane, once the post-reveal warm-up has settled. */
async function waitForMountedTabs(page: Page, tabIds: readonly string[]): Promise<string[]> {
  const read = () =>
    page.evaluate(
      (ids) => ids.filter((id) => window.__paneManagers?.has(id) === true).sort(),
      [...tabIds]
    )
  await expect
    .poll(async () => (await read()).length, {
      timeout: 20_000,
      message: 'activation-deferred tabs never mounted after the reveal'
    })
    .toBe(tabIds.length)
    .catch(() => undefined)
  return read()
}

async function measureSwitch(
  page: Page,
  targetWorktreeId: string,
  targetTabIds: readonly string[]
): Promise<SwitchSample> {
  await page.evaluate(
    ({ worktreeId, tabIds }) => {
      const probe = {
        t0: performance.now(),
        activationMs: null as number | null,
        paneMountedMs: null as number | null,
        contentRestoredMs: null as number | null,
        frames: [] as number[],
        longTasks: [] as number[],
        mountedAtActivation: 0,
        stop: () => {}
      }
      globalThis.__switchPaintProbe = probe
      let observer: PerformanceObserver | null = null
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            probe.longTasks.push(entry.duration)
          }
        })
        observer.observe({ entryTypes: ['longtask'] })
      } catch {
        /* longtask unsupported */
      }
      let running = true
      const visibleTabId = () => {
        const state = window.__store!.getState()
        return state.activeWorktreeId === worktreeId && state.activeTabType === 'terminal'
          ? state.activeTabId
          : (state.activeTabIdByWorktree?.[worktreeId] ?? null)
      }
      const tick = () => {
        if (!running) {
          return
        }
        const now = performance.now() - probe.t0
        probe.frames.push(now)
        const state = window.__store!.getState()
        if (probe.activationMs === null && state.activeWorktreeId === worktreeId) {
          probe.activationMs = now
          // Sample in the switch frame before idle admission to count panes mounted by the switch itself.
          probe.mountedAtActivation = tabIds.filter(
            (id) => window.__paneManagers?.has(id) === true
          ).length
        }
        const tabId = visibleTabId()
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        if (probe.paneMountedMs === null && pane?.container?.isConnected) {
          probe.paneMountedMs = now
        }
        if (probe.contentRestoredMs === null && pane) {
          // Observe nonempty viewport in a frame callback: content is renderable one frame before pixels; this is not a pixel assertion.
          const buffer = pane.terminal.buffer.active
          let filledRows = 0
          for (let row = 0; row < pane.terminal.rows; row += 1) {
            const line = buffer.getLine(buffer.viewportY + row)
            if (line && line.translateToString(true).trim().length > 0) {
              filledRows += 1
            }
          }
          if (filledRows >= Math.min(5, pane.terminal.rows)) {
            probe.contentRestoredMs = now
          }
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      probe.stop = () => {
        running = false
        try {
          observer?.disconnect()
        } catch {
          /* ignore */
        }
      }
      window.__store!.getState().setActiveWorktree(worktreeId)
    },
    { worktreeId: targetWorktreeId, tabIds: [...targetTabIds] }
  )

  // Poll until restore completes across slow runners instead of reporting a deadline as never-restored.
  await expect
    .poll(() => page.evaluate(() => globalThis.__switchPaintProbe?.contentRestoredMs ?? null), {
      timeout: 30_000,
      message: 'revealed terminal never restored its content'
    })
    .not.toBeNull()
  // Let the idle admission drain so the settled-resource readings are steady.
  await page.waitForTimeout(2_000)

  return page.evaluate(() => {
    const probe = globalThis.__switchPaintProbe!
    probe.stop()
    let maxGap = 0
    let previous = 0
    for (const frame of probe.frames) {
      maxGap = Math.max(maxGap, frame - previous)
      previous = frame
    }
    let settledPanes = 0
    let settledWebglContexts = 0
    const managers = window.__paneManagers
    for (const manager of managers?.values() ?? []) {
      settledPanes += (manager.getPanes?.() ?? []).length
      // Use diagnostics: the public getPanes projection has no webglAddon, so reading it always gives falsy.
      const diagnostics =
        (
          manager as { getRenderingDiagnostics?: () => { hasWebgl?: boolean }[] }
        ).getRenderingDiagnostics?.() ?? []
      settledWebglContexts += diagnostics.filter((entry) => entry.hasWebgl === true).length
    }
    return {
      settledPaneManagers: managers?.size ?? 0,
      settledPanes,
      settledWebglContexts,
      activationMs: probe.activationMs,
      paneMountedMs: probe.paneMountedMs,
      contentRestoredMs: probe.contentRestoredMs,
      maxFrameGapMs: +maxGap.toFixed(1),
      longTaskTotalMs: +probe.longTasks.reduce((total, value) => total + value, 0).toFixed(1),
      worstLongTaskMs: +probe.longTasks
        .reduce((worst, value) => Math.max(worst, value), 0)
        .toFixed(1),
      mountedAtActivation: probe.mountedAtActivation
    }
  })
}

function report(label: string, sample: SwitchSample): string {
  return [
    `${label}:`,
    `  activation        ${sample.activationMs?.toFixed(1) ?? 'n/a'}ms`,
    `  pane mounted      ${sample.paneMountedMs?.toFixed(1) ?? 'n/a'}ms`,
    `  content restored  ${sample.contentRestoredMs?.toFixed(1) ?? 'never'}ms`,
    `  max frame gap     ${sample.maxFrameGapMs}ms`,
    `  long tasks        total=${sample.longTaskTotalMs}ms worst=${sample.worstLongTaskMs}ms`,
    `  panes at switch   ${sample.mountedAtActivation}/${TABS_PER_WORKTREE}`,
    `  settled resources managers=${sample.settledPaneManagers} panes=${sample.settledPanes} webgl=${sample.settledWebglContexts}`
  ].join('\n')
}

async function publish(testInfo: TestInfo, name: string, body: string): Promise<void> {
  console.log(body)
  await testInfo.attach(name, { body, contentType: 'text/plain' })
}

// Visit eight extras to outgrow four-worktree hot retention plus last-active exemption, forcing a cold target.
const FILLER_WORKTREE_COUNT = Number(process.env.ORCA_SWITCH_FILLER_WORKTREES ?? '8')

async function addFillerWorktrees(
  page: Page,
  testRepoPath: string
): Promise<{ ids: string[]; cleanup: () => void }> {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-switch-paint-')))
  const paths = Array.from({ length: FILLER_WORKTREE_COUNT }, (_, index) =>
    path.join(parent, `filler-${index}`)
  )
  const removeAll = (): void => {
    for (const worktreePath of paths) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: testRepoPath,
          stdio: 'ignore'
        })
      } catch {
        /* best effort */
      }
    }
    rmSync(parent, { recursive: true, force: true })
  }
  // Clean partial fixtures before rethrowing because later specs reuse the worker repo.
  try {
    for (const worktreePath of paths) {
      execFileSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
        cwd: testRepoPath,
        stdio: 'ignore'
      })
    }
  } catch (error) {
    removeAll()
    throw error
  }
  try {
    return await registerFillerWorktrees(page, testRepoPath, paths, removeAll)
  } catch (error) {
    removeAll()
    throw error
  }
}

async function registerFillerWorktrees(
  page: Page,
  testRepoPath: string,
  paths: readonly string[],
  cleanup: () => void
): Promise<{ ids: string[]; cleanup: () => void }> {
  const repoId = await page.evaluate(
    (repoPath) =>
      window.__store!.getState().repos.find((repo) => repo.path === repoPath)?.id ?? null,
    testRepoPath
  )
  if (!repoId) {
    throw new Error(`seeded repo not registered: ${testRepoPath}`)
  }
  await loadWorktreesUntilPathsPresent(page, repoId, [...paths])
  const ids = await page.evaluate(
    ({ id, wanted }) =>
      (window.__store!.getState().worktreesByRepo[id] ?? [])
        .filter((worktree) => wanted.includes(worktree.path))
        .map((worktree) => worktree.id),
    { id: repoId, wanted: paths }
  )
  return { ids, cleanup }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

// Linux needs a mapped window for animation frames after reload; run on an isolated display.
test.describe('Worktree switch first paint @headful', () => {
  test.skip(
    process.env.ORCA_BACKGROUND_LAUNCH === '1',
    'First-paint measurement requires a mapped window'
  )
  test('repaints an unmounted worktree within the switch budget', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.setTimeout(900_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    const worktreeIds = await getAllWorktreeIds(orcaPage)
    expect(worktreeIds.length).toBeGreaterThanOrEqual(2)
    const [primaryId, targetId] = worktreeIds
    const filler = await addFillerWorktrees(orcaPage, testRepoPath)

    const samples: SwitchSample[] = []
    const lines: string[] = []
    try {
      const targetTabIds = await ensureTabs(orcaPage, targetId, 'WTB')

      // Seed persisted tabs without mounting them, matching 846 tabs/449 worktrees.
      await orcaPage.evaluate(
        ({ ids, perWorktree }) => {
          const state = window.__store!.getState()
          for (const id of ids) {
            const existing = state.tabsByWorktree[id] ?? []
            for (let index = existing.length; index < perWorktree; index += 1) {
              state.createTab(id)
            }
          }
        },
        { ids: filler.ids, perWorktree: 2 }
      )

      for (let round = 0; round < SWITCH_SAMPLE_COUNT; round += 1) {
        // Persist primary as active before reload so target returns session-only, never mounted in this renderer.
        await switchToWorktree(orcaPage, primaryId)
        await ensureTerminalVisible(orcaPage)
        await orcaPage.waitForTimeout(2_500)
        await orcaPage.reload()
        await waitForSessionReady(orcaPage)
        await waitForActiveWorktree(orcaPage)
        await ensureTerminalVisible(orcaPage)
        await orcaPage.waitForTimeout(2_500)
        const unmounted = await waitForUnmountedTabs(orcaPage, targetTabIds)
        expect(unmounted, 'target worktree was already mounted before the switch').toBe(true)

        const sample = await measureSwitch(orcaPage, targetId, targetTabIds)
        samples.push(sample)
        lines.push(report(`round ${round + 1} (target unmounted=${unmounted})`, sample))

        // Require skipped hidden tabs to warm afterward so faster reveal does not make the next tab switch cold.
        const warmedTabIds = await waitForMountedTabs(orcaPage, targetTabIds)
        expect(warmedTabIds, 'deferred tabs never joined the warm working set').toEqual(
          [...targetTabIds].sort()
        )
      }
    } finally {
      filler.cleanup()
    }

    const restored = samples
      .map((sample) => sample.contentRestoredMs)
      .filter((value): value is number => value !== null)
    expect(restored.length, 'revealed terminal never restored its content').toBe(samples.length)
    const summary = [
      `first activation -> ${TABS_PER_WORKTREE}-tab worktree, ${samples.length} rounds`,
      `  content restored: median=${median(restored).toFixed(1)}ms samples=${restored
        .map((value) => value.toFixed(0))
        .join(', ')}ms`,
      `  activation:      median=${median(
        samples.map((sample) => sample.activationMs ?? 0)
      ).toFixed(1)}ms`,
      `  panes at switch: ${samples.map((sample) => sample.mountedAtActivation).join(', ')}`,
      `  settled panes:   ${samples.map((sample) => sample.settledPanes).join(', ')}`,
      `  settled webgl:   ${samples.map((sample) => sample.settledWebglContexts).join(', ')}`,
      '',
      ...lines
    ].join('\n')
    await publish(testInfo, 'first-activation-switch.txt', summary)

    for (const sample of samples) {
      expect(
        sample.mountedAtActivation,
        'the switch mounted more than the pane the user is looking at'
      ).toBe(1)
    }
    // Exempt CI only from timing; exact one-pane admission and restored warm-set invariants still gate shared runners.
    if (process.env.CI) {
      console.log(
        `[switch-budget] CI run, latency budget not enforced (median ${median(restored).toFixed(1)}ms)`
      )
      return
    }
    expect(median(restored)).toBeLessThanOrEqual(FIRST_PAINT_BUDGET_MS)
  })
})
