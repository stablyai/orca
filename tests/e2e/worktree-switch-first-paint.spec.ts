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

/**
 * Worktree-switch first-paint budget.
 *
 * Why this exists: worktree-switch-responsiveness.spec.ts proves the click task
 * stays short, and the reveal-convergence spec proves the buffer eventually
 * matches. Neither covers the symptom users report — the revealed terminal is
 * BLANK for a beat after the switch. This measures the phase that owns that
 * beat: switch click -> revealed pane has painted its restored content.
 *
 * The scenario is the one that dominates at many-worktree scale: a switch to a
 * worktree whose tabs are in the persisted session but have never been mounted
 * in this renderer. Hot-retain only keeps 4 worktrees warm, so with hundreds of
 * worktrees essentially every switch is this one. Reloading the renderer between
 * rounds reproduces it exactly, at production parking timings.
 */

// Why 3: the field profile that motivated this budget has 449 worktrees whose
// median tab count is 2-3, so a 3-tab worktree is the switch users actually pay for.
const TABS_PER_WORKTREE = Number(process.env.ORCA_SWITCH_TABS ?? '3')
const SCROLLBACK_LINES = 1_500
// Budget: a switch has to look instant. Anything over this reads as a stall.
const FIRST_PAINT_BUDGET_MS = Number(process.env.ORCA_SWITCH_BUDGET_MS ?? '250')
// Why repeat: a single cold reveal on a loaded dev machine swings by tens of ms,
// which is the same order as the effect under test.
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
        state.setActiveTabType('terminal')
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
          // Why here and not at paint: this is the switch's own frame, before any
          // idle admission can run, so it measures what the SWITCH mounted.
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
          // Restored = the revealed viewport carries real text rather than an
          // empty grid. Read on a frame callback, so this is the frame the
          // content became renderable — one frame ahead of the pixels, and not
          // a pixel assertion. Both arms are measured identically.
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

  // Why poll rather than sample a fixed window: the measurement is "how long did
  // the restore take", so the harness must outlast the slowest runner rather than
  // give up at a deadline and report the reveal as never restoring.
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
      // Why diagnostics and not `pane.webglAddon`: getPanes() hands back a public
      // projection that has no webglAddon field, so reading it is always falsy.
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

// Why 8 extra: hot-retain keeps the 4 most recently hidden worktrees mounted and
// exempts the last-active one, so a target only cold-parks once enough other
// worktrees have been visited after it. That is the steady state at field scale.
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
  // Why clean up before rethrowing: testRepoPath is worker-scoped and reused by
  // later specs, so a half-built fixture would leak worktrees into them.
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

      // Give the filler worktrees persisted tabs without mounting them, so the
      // store carries a field-scale tab population (the profile that motivated
      // this budget has 846 tabs across 449 worktrees).
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
        // Leave the primary active and let the session persist before reloading:
        // startup restores the persisted active worktree, so this is what makes
        // the target come back with tabs in the session and no pane ever mounted
        // — the state every switch lands in once the worktree count exceeds the
        // hot-retain working set.
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

        // The half of the contract that keeps the speed-up free: the hidden tabs
        // the switch skipped still end up mounted, so the next tab switch is as
        // warm as it was before the reveal stopped mounting them up front.
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
    // Why CI is exempt from the budget and not from the invariants: shared
    // runners cannot hold a latency threshold, but "the switch mounted one pane"
    // and "the warm set came back" are exact and are the real regression guards.
    if (process.env.CI) {
      console.log(
        `[switch-budget] CI run, latency budget not enforced (median ${median(restored).toFixed(1)}ms)`
      )
      return
    }
    expect(median(restored)).toBeLessThanOrEqual(FIRST_PAINT_BUDGET_MS)
  })
})
