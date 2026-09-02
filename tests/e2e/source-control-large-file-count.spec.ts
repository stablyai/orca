/**
 * Benchmark + repro suite for issue #8013: repos with ~10,000+ files make the
 * renderer's memory grow and the UI unresponsive.
 *
 * Each scenario builds an isolated on-disk repo at a controlled scale, drives
 * the real status pipeline (git scan → line stats → IPC → store → Source
 * Control rows), and measures:
 *   - scanMs           main-process `git status` + line-stat duration
 *   - payloadBytes     serialized status payload size crossing IPC
 *   - renderMs         time from setGitStatus until rows are in the DOM
 *   - maxLagMs/p95     event-loop lag while loading (UI responsiveness)
 *   - domNodeCount     total DOM nodes after render
 *   - heap growth      JS heap across repeated poll cycles (leak signal)
 *
 * Run a single scenario at a custom scale:
 *   ORCA_LARGE_FILE_COUNT=9500 npx playwright test \
 *     tests/e2e/source-control-large-file-count.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  createLargeFileCountRepo,
  removeLargeFileCountRepo,
  removeLargeFileCountUntrackedTree
} from './large-file-count-fixtures'
import { DEFAULT_GIT_STATUS_LIMIT } from '../../src/shared/git-status-limit'

// Matches the large-diff freeze budget: a blocking stall past 1s is the
// "UI becomes unresponsive" symptom reported in #8013.
const MAX_EVENT_LOOP_LAG_MS = 1_000
// A second full status→store→render cycle with identical data must not leak
// unbounded memory; allow generous headroom for GC timing noise.
const MAX_HEAP_GROWTH_PER_CYCLE_MB = 75

// A virtualized list mounts viewport + overscan rows only; anything past this
// bound means the panel is mounting rows proportional to the change set again.
const MAX_MOUNTED_ROWS = 200
const MAX_CAPPED_STATUS_PAYLOAD_BYTES = 200_000

type LoadMeasurement = {
  entryCount: number
  didHitLimit: boolean
  scanMs: number
  rescanMs: number
  payloadBytes: number
  renderMs: number
  renderedRows: number
  maxLagMs: number
  p95LagMs: number
  domNodeCount: number
  heapUsedMbAfterRender: number
  heapUsedMbPerCycle: number[]
  cycleMaxLagMs: number[]
}

async function addAndActivateRepo(orcaPage: Page, repoPath: string): Promise<string> {
  const repoId = await orcaPage.evaluate(async (pathToRepo: string) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const addedRepo = await store.getState().addRepoPath(pathToRepo)
    if (!addedRepo) {
      throw new Error(`isolated repo not found: ${pathToRepo}`)
    }
    return addedRepo.id
  }, repoPath)

  // Why: fetchWorktrees() resolves before Zustand always reflects the async
  // worktree scan, so poll the same public store path real repo setup uses.
  await expect
    .poll(
      () =>
        orcaPage.evaluate(async (targetRepoId: string) => {
          const store = window.__store
          if (!store) {
            return 0
          }
          await store.getState().fetchWorktrees(targetRepoId)
          return store.getState().worktreesByRepo[targetRepoId]?.length ?? 0
        }, repoId),
      { timeout: 30_000, message: 'isolated large-file-count worktree did not load' }
    )
    .toBeGreaterThan(0)

  const worktreeId = await orcaPage.evaluate(
    ({ targetRepoId, pathToRepo }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const worktrees = state.worktreesByRepo[targetRepoId] ?? []
      const worktree = worktrees.find((entry) => entry.path === pathToRepo) ?? worktrees[0]
      if (!worktree) {
        throw new Error(`isolated worktree not found: ${pathToRepo}`)
      }
      state.setActiveRepo(targetRepoId)
      state.setActiveWorktree(worktree.id)
      state.setRightSidebarOpen(true)
      state.setRightSidebarTab('source-control')
      return worktree.id
    },
    { targetRepoId: repoId, pathToRepo: repoPath }
  )

  // Why: repo activation can finish sidebar routing after the store mutation;
  // assert the user-visible panel before timing its render. Clicking the
  // already-active activity button races the first cold status scan and tests
  // Playwright's two-frame actionability window instead of panel readiness.
  const sourceControlButton = orcaPage.getByRole('button', { name: /^Source Control/ })
  await expect(sourceControlButton).toBeVisible()
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().rightSidebarTab))
    .toBe('source-control')
  await expect(orcaPage.getByRole('button', { name: 'Filter files by name' })).toBeVisible()

  return worktreeId
}

async function unregisterLargeFileCountRepos(
  orcaPage: Page,
  repoPaths: readonly string[]
): Promise<void> {
  // Why: remove disposable projects through the product so their terminals
  // and watcher subscriptions begin shutting down before Electron teardown.
  for (const repoPath of repoPaths) {
    await orcaPage.evaluate(async (pathToRepo) => {
      const store = window.__store
      const repo = store?.getState().repos.find((entry) => entry.path === pathToRepo)
      if (repo) {
        await store?.getState().removeProject(repo.id)
      }
    }, repoPath)
  }
}

/**
 * Drives the exact pipeline the panel's poll uses (api.git.status →
 * setGitStatus) so results are deterministic even while the built-in 3s poll
 * runs concurrently — the poll produces identical entries, which the store
 * dedupes.
 */
async function measureSourceControlLoad(
  orcaPage: Page,
  args: { worktreeId: string; repoPath: string; expectedRows: number; pollCycles: number }
): Promise<LoadMeasurement> {
  return await orcaPage.evaluate(async ({ worktreeId, repoPath, expectedRows, pollCycles }) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const lagSamples: number[] = []
    const probeIntervalMs = 50
    let lastTick = performance.now()
    const probe = window.setInterval(() => {
      const now = performance.now()
      lagSamples.push(Math.max(0, now - lastTick - probeIntervalMs))
      lastTick = now
    }, probeIntervalMs)

    const readHeapMb = (): number => {
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      return memory ? memory.usedJSHeapSize / (1024 * 1024) : -1
    }

    try {
      const scanStart = performance.now()
      const status = await window.api.git.status({ worktreePath: repoPath })
      const scanMs = performance.now() - scanStart
      const payloadBytes = JSON.stringify(status).length

      // Why: a virtualized panel mounts only viewport rows, so "all rows in
      // the DOM" would never happen post-fix. First rows appearing is the
      // user-visible "list loaded" moment either way.
      const firstRowsTarget = Math.min(expectedRows, 30)
      const renderStart = performance.now()
      store.getState().setGitStatus(worktreeId, status)
      let renderedRows = 0
      while (performance.now() - renderStart < 60_000) {
        renderedRows = document.querySelectorAll('[data-testid="source-control-entry"]').length
        if (renderedRows >= firstRowsTarget) {
          break
        }
        await new Promise((resolve) => window.setTimeout(resolve, 50))
      }
      const renderMs = performance.now() - renderStart
      // Settle so the lag probe captures post-render layout/paint stalls too.
      await new Promise((resolve) => window.setTimeout(resolve, 1_000))
      renderedRows = document.querySelectorAll('[data-testid="source-control-entry"]').length
      const heapUsedMbAfterRender = readHeapMb()

      // Why: #8013 reports memory that keeps growing — replay the poll cycle
      // (fresh scan, fresh entry array, store update) and track heap + lag.
      const heapUsedMbPerCycle: number[] = []
      const cycleMaxLagMs: number[] = []
      let rescanMs = 0
      for (let cycle = 0; cycle < pollCycles; cycle += 1) {
        const cycleLagStart = lagSamples.length
        const cycleScanStart = performance.now()
        const cycleStatus = await window.api.git.status({ worktreePath: repoPath })
        if (cycle === 0) {
          // First rescan isolates warm-cache scan cost (untracked line-stat
          // reads are mtime-cached after the initial scan).
          rescanMs = performance.now() - cycleScanStart
        }
        store.getState().setGitStatus(worktreeId, cycleStatus)
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        heapUsedMbPerCycle.push(readHeapMb())
        cycleMaxLagMs.push(Math.max(0, ...lagSamples.slice(cycleLagStart)))
      }

      const sorted = [...lagSamples].sort((a, b) => a - b)
      return {
        entryCount: status.entries.length,
        didHitLimit: status.didHitLimit === true,
        scanMs,
        rescanMs,
        payloadBytes,
        renderMs,
        renderedRows,
        maxLagMs: sorted.length ? (sorted.at(-1) ?? 0) : 0,
        p95LagMs: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0,
        domNodeCount: document.getElementsByTagName('*').length,
        heapUsedMbAfterRender,
        heapUsedMbPerCycle,
        cycleMaxLagMs
      }
    } finally {
      window.clearInterval(probe)
    }
  }, args)
}

function logMeasurement(
  label: string,
  measurement: LoadMeasurement & { rendererWorkingSetMb?: { before: number; after: number } }
): void {
  console.log(`[large-file-count] ${label} ${JSON.stringify(measurement)}`)
}

/**
 * OS-level working set of all renderer processes, in MB. The #8013 report is
 * about renderer memory; JS heap alone misses DOM/native memory, which
 * dominates when hundreds of thousands of nodes mount.
 */
async function readRendererWorkingSetMb(electronApp: ElectronApplication): Promise<number> {
  return await electronApp.evaluate(({ app }) => {
    let totalKb = 0
    for (const metric of app.getAppMetrics()) {
      if (metric.type === 'Tab') {
        totalKb += metric.memory.workingSetSize
      }
    }
    return totalKb / 1024
  })
}

test.describe('Source Control large file count (#8013)', () => {
  // Why: each scenario gets its own Electron app + isolated fixture repo, so a
  // failing scale must not skip the others — every scenario is a data point.
  test.use({ seedTestRepo: false })

  test('a large untracked set under the status cap stays responsive', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    test.setTimeout(600_000)
    const untrackedFiles = Number(process.env.ORCA_LARGE_FILE_COUNT ?? '950')
    // Why: ORCA_LARGE_FILE_BYTES gives untracked files realistic sizes so the
    // per-poll line-stat reads (cache-capped at 2,048 entries) become visible
    // in rescanMs instead of hiding behind ~30-byte fixture files.
    const untrackedFileBytes = Number(process.env.ORCA_LARGE_FILE_BYTES ?? '0')
    const fixture = createLargeFileCountRepo({
      trackedFiles: 100,
      untrackedFiles,
      untrackedFileBytes
    })
    registerPostElectronShutdownCleanup(() => removeLargeFileCountRepo(fixture.repoPath))
    try {
      await waitForSessionReady(orcaPage)
      const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
      const workingSetBeforeMb = await readRendererWorkingSetMb(electronApp)
      const measurement = await measureSourceControlLoad(orcaPage, {
        worktreeId,
        repoPath: fixture.repoPath,
        expectedRows: untrackedFiles,
        pollCycles: 3
      })
      const workingSetAfterMb = await readRendererWorkingSetMb(electronApp)
      logMeasurement(`untracked=${untrackedFiles}`, {
        ...measurement,
        rendererWorkingSetMb: { before: workingSetBeforeMb, after: workingSetAfterMb }
      })

      expect(measurement.didHitLimit).toBe(false)
      expect(measurement.entryCount).toBeGreaterThanOrEqual(untrackedFiles)
      expect(measurement.renderedRows).toBeGreaterThan(0)
      // Why: mounting rows proportional to the change set is the #8013 bug;
      // a virtualized panel mounts viewport + overscan only.
      expect(measurement.renderedRows).toBeLessThan(MAX_MOUNTED_ROWS)
      expect(measurement.maxLagMs).toBeLessThan(MAX_EVENT_LOOP_LAG_MS)
      if (measurement.heapUsedMbPerCycle.length > 1) {
        const first = measurement.heapUsedMbPerCycle[0]
        const last = measurement.heapUsedMbPerCycle.at(-1) ?? first
        expect(last - first).toBeLessThan(
          MAX_HEAP_GROWTH_PER_CYCLE_MB * (measurement.heapUsedMbPerCycle.length - 1)
        )
      }
    } finally {
      await unregisterLargeFileCountRepos(orcaPage, [fixture.repoPath])
    }
  })

  test('a large modified set under the status cap stays responsive', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    test.setTimeout(600_000)
    const modifiedFiles = Number(process.env.ORCA_LARGE_FILE_COUNT ?? '750')
    const fixture = createLargeFileCountRepo({ trackedFiles: modifiedFiles, modifiedFiles })
    registerPostElectronShutdownCleanup(() => removeLargeFileCountRepo(fixture.repoPath))
    try {
      await waitForSessionReady(orcaPage)
      const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
      const workingSetBeforeMb = await readRendererWorkingSetMb(electronApp)
      const measurement = await measureSourceControlLoad(orcaPage, {
        worktreeId,
        repoPath: fixture.repoPath,
        expectedRows: modifiedFiles,
        pollCycles: 3
      })
      const workingSetAfterMb = await readRendererWorkingSetMb(electronApp)
      logMeasurement(`modified=${modifiedFiles}`, {
        ...measurement,
        rendererWorkingSetMb: { before: workingSetBeforeMb, after: workingSetAfterMb }
      })

      expect(measurement.didHitLimit).toBe(false)
      expect(measurement.entryCount).toBeGreaterThanOrEqual(modifiedFiles)
      expect(measurement.renderedRows).toBeGreaterThan(0)
      expect(measurement.renderedRows).toBeLessThan(MAX_MOUNTED_ROWS)
      expect(measurement.maxLagMs).toBeLessThan(MAX_EVENT_LOOP_LAG_MS)
    } finally {
      await unregisterLargeFileCountRepos(orcaPage, [fixture.repoPath])
    }
  })

  test('a change set over the status cap degrades to the too-many-changes state', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    test.setTimeout(600_000)
    const untrackedFiles = 12_000
    const fixture = createLargeFileCountRepo({ untrackedFiles })
    registerPostElectronShutdownCleanup(() => removeLargeFileCountRepo(fixture.repoPath))
    try {
      await waitForSessionReady(orcaPage)
      await orcaPage.evaluate(() => {
        const probe = { lastTick: performance.now(), maxLagMs: 0, timer: 0 }
        probe.timer = window.setInterval(() => {
          const now = performance.now()
          probe.maxLagMs = Math.max(probe.maxLagMs, now - probe.lastTick - 50)
          probe.lastTick = now
        }, 50)
        ;(
          window as unknown as {
            __sourceControlActivationLagProbe?: typeof probe
          }
        ).__sourceControlActivationLagProbe = probe
      })
      const activationStart = performance.now()
      const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
      const activationMs = performance.now() - activationStart
      const activationMaxLagMs = await orcaPage.evaluate(() => {
        const target = window as unknown as {
          __sourceControlActivationLagProbe?: {
            maxLagMs: number
            timer: number
          }
        }
        const probe = target.__sourceControlActivationLagProbe
        if (!probe) {
          return -1
        }
        window.clearInterval(probe.timer)
        delete target.__sourceControlActivationLagProbe
        return probe.maxLagMs
      })
      console.log(
        `[large-file-count] initial-activation ${JSON.stringify({ activationMs, activationMaxLagMs })}`
      )
      const workingSetBeforeMb = await readRendererWorkingSetMb(electronApp)
      const measurement = await measureSourceControlLoad(orcaPage, {
        worktreeId,
        repoPath: fixture.repoPath,
        // The capped payload still carries DEFAULT_GIT_STATUS_LIMIT entries;
        // the panel may render them, but must stay responsive while doing so.
        expectedRows: 0,
        pollCycles: 1
      })
      const workingSetAfterMb = await readRendererWorkingSetMb(electronApp)
      logMeasurement(`over-cap untracked=${untrackedFiles}`, {
        ...measurement,
        rendererWorkingSetMb: { before: workingSetBeforeMb, after: workingSetAfterMb }
      })

      const tooManyChangesBanner = orcaPage.getByText('Too many changes detected.', {
        exact: false
      })
      await expect(tooManyChangesBanner).toBeVisible()
      if (process.env.ORCA_LARGE_FILE_SCREENSHOT_PATH) {
        await orcaPage.screenshot({ path: process.env.ORCA_LARGE_FILE_SCREENSHOT_PATH })
      }

      expect(measurement.didHitLimit).toBe(true)
      expect(measurement.entryCount).toBeLessThanOrEqual(DEFAULT_GIT_STATUS_LIMIT)
      expect(measurement.payloadBytes).toBeLessThan(MAX_CAPPED_STATUS_PAYLOAD_BYTES)
      expect(measurement.renderedRows).toBeLessThan(MAX_MOUNTED_ROWS)
      expect(measurement.maxLagMs).toBeLessThan(MAX_EVENT_LOOP_LAG_MS)
      expect(activationMaxLagMs).toBeLessThan(MAX_EVENT_LOOP_LAG_MS)

      // Why: didHitLimit must park the worktree in the huge-status state so
      // background polling stops re-running tens-of-seconds git scans.
      const hugeState = await orcaPage.evaluate(
        (wId) => window.__store?.getState().gitStatusHugeByWorktree?.[wId] ?? null,
        worktreeId
      )
      expect(hugeState).not.toBeNull()

      // Why: watcher refreshes stay parked while huge; the visible Retry is the
      // explicit recovery path after the underlying change count drops.
      removeLargeFileCountUntrackedTree(fixture.repoPath)
      await expect(tooManyChangesBanner).toBeVisible()
      await orcaPage.getByRole('button', { name: 'Retry' }).click()
      await expect(tooManyChangesBanner).not.toBeVisible()
      await expect
        .poll(() =>
          orcaPage.evaluate(
            (wId) => window.__store?.getState().gitStatusHugeByWorktree?.[wId] ?? null,
            worktreeId
          )
        )
        .toBeNull()
    } finally {
      await unregisterLargeFileCountRepos(orcaPage, [fixture.repoPath])
    }
  })

  test('untracked line-stat cache stays effective up to the status cap', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    test.setTimeout(600_000)
    // Why: compare warm rescan cost at two sub-cap scales on the same machine;
    // a cache sized below one complete status result makes the ratio balloon.
    const fileBytes = 65_536
    const smallRepo = createLargeFileCountRepo({
      trackedFiles: 10,
      untrackedFiles: 400,
      untrackedFileBytes: fileBytes
    })
    registerPostElectronShutdownCleanup(() => removeLargeFileCountRepo(smallRepo.repoPath))
    let largeRepo: ReturnType<typeof createLargeFileCountRepo> | null = null
    try {
      largeRepo = createLargeFileCountRepo({
        trackedFiles: 10,
        untrackedFiles: 800,
        untrackedFileBytes: fileBytes
      })
      const largeRepoPath = largeRepo.repoPath
      registerPostElectronShutdownCleanup(() => removeLargeFileCountRepo(largeRepoPath))
      await waitForSessionReady(orcaPage)

      const warmRescanPerFileMs = async (repoPath: string, files: number): Promise<number> => {
        const worktreeId = await addAndActivateRepo(orcaPage, repoPath)
        const measurement = await measureSourceControlLoad(orcaPage, {
          worktreeId,
          repoPath,
          expectedRows: files,
          pollCycles: 1
        })
        return measurement.rescanMs / files
      }

      const smallPerFileMs = await warmRescanPerFileMs(smallRepo.repoPath, 400)
      const largePerFileMs = await warmRescanPerFileMs(largeRepo.repoPath, 800)
      console.log(
        `[large-file-count] line-stat-cache smallPerFileMs=${smallPerFileMs.toFixed(4)} largePerFileMs=${largePerFileMs.toFixed(4)} ratio=${(largePerFileMs / smallPerFileMs).toFixed(2)}`
      )
      expect(largePerFileMs).toBeLessThan(smallPerFileMs * 2)
    } finally {
      await unregisterLargeFileCountRepos(orcaPage, [
        smallRepo.repoPath,
        ...(largeRepo ? [largeRepo.repoPath] : [])
      ])
    }
  })

  test('a large clean repo (tracked files only) loads instantly', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    test.setTimeout(600_000)
    const trackedFiles = Number(process.env.ORCA_LARGE_FILE_COUNT ?? '15000')
    const fixture = createLargeFileCountRepo({ trackedFiles })
    registerPostElectronShutdownCleanup(() => removeLargeFileCountRepo(fixture.repoPath))
    try {
      await waitForSessionReady(orcaPage)
      const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
      const workingSetBeforeMb = await readRendererWorkingSetMb(electronApp)
      const measurement = await measureSourceControlLoad(orcaPage, {
        worktreeId,
        repoPath: fixture.repoPath,
        expectedRows: 0,
        pollCycles: 2
      })
      const workingSetAfterMb = await readRendererWorkingSetMb(electronApp)
      logMeasurement(`clean tracked=${trackedFiles}`, {
        ...measurement,
        rendererWorkingSetMb: { before: workingSetBeforeMb, after: workingSetAfterMb }
      })

      expect(measurement.entryCount).toBe(0)
      expect(measurement.maxLagMs).toBeLessThan(MAX_EVENT_LOOP_LAG_MS)
    } finally {
      await unregisterLargeFileCountRepos(orcaPage, [fixture.repoPath])
    }
  })
})
