import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { waitForTerminalPtyDataInjector } from './helpers/terminal-pty-injection'

// Repro commands:
//   SKIP_BUILD=1 pnpm exec playwright test tests/e2e/terminal-foreground-redraw-freeze.spec.ts --config tests/playwright.config.ts --project electron-headless -g "active OpenTUI-style"
//   git clone https://github.com/anomalyco/opencode.git .tmp/opencode
//   node tests/e2e/capture-opencode-tui-repro.mjs
//   SKIP_BUILD=1 pnpm exec playwright test tests/e2e/terminal-foreground-redraw-freeze.spec.ts --config tests/playwright.config.ts --project electron-headless -g "captured OpenCode/OpenTUI" --reporter=json
// The captured replay uses an artificial OpenCode source-tree harness that
// imports OpenCode's spinner frames and emits real OpenTUI <=2KB redraw chunks.

type SchedulerDebugSnapshot = {
  deferredForegroundEnqueueCount: number
  foregroundWriteCount: number
  deferredForegroundWriteCount: number
  scheduledDrainCount: number
  drainWrites: number[]
}

type BurstMeasurement = {
  elapsedMs: number
  injectedFrames: number
  maxTimerDriftMs: number
  samples: number
}

type SchedulerDebugWindow = Window & {
  __terminalOutputSchedulerDebug?: {
    reset: () => void
    snapshot: () => SchedulerDebugSnapshot
  }
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string) => boolean
  }
}

type RefreshProbeWindow = SchedulerDebugWindow & {
  __terminalRefreshProbe?: {
    snapshot: () => RefreshProbeSnapshot
    dispose: () => void
  }
}

type RefreshProbeSnapshot = {
  synchronousWebgl: number
  synchronousDom: number
  debouncedWebgl: number
  debouncedDom: number
}

const REDRAW_FRAME_COUNT = 270
const REDRAW_PAYLOAD_CHARS = 520
const REWRITE_REDRAW_FRAME_COUNT = REDRAW_FRAME_COUNT
const REWRITE_REDRAW_PAYLOAD_CHARS = REDRAW_PAYLOAD_CHARS
const TIMER_SAMPLE_MS = 16
const MAX_RENDERER_TIMER_DRIFT_MS = 500
const FOREGROUND_IMMEDIATE_BUDGET_CHARS = 128 * 1024
const OPENCODE_CAPTURE_REPLAY_CHARS = FOREGROUND_IMMEDIATE_BUDGET_CHARS * 64
const OPENCODE_CAPTURE_PATH = path.join(process.cwd(), '.tmp', 'opencode-tui-capture.txt')

async function resetSchedulerDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    const debug = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug
    if (!debug) {
      throw new Error('terminal output scheduler debug API is unavailable')
    }
    debug.reset()
  })
}

async function readSchedulerDebug(page: Page): Promise<SchedulerDebugSnapshot> {
  return page.evaluate(() => {
    const debug = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug
    if (!debug) {
      throw new Error('terminal output scheduler debug API is unavailable')
    }
    return debug.snapshot()
  })
}

async function measureRendererDuringBurst(page: Page, paneKey: string): Promise<BurstMeasurement> {
  const frames = Array.from({ length: REDRAW_FRAME_COUNT }, (_, frame) => {
    const text = `OpenTUI active redraw #${String(frame).padStart(4, '0')}`
    const payload = 'x'.repeat(REDRAW_PAYLOAD_CHARS)
    return (
      '\x1b[?2026h' +
      '\x1b[?25l' +
      `\x1b[2;3H\x1b[38;2;255;138;0m${text}\x1b[0m` +
      `\x1b[4;6H\x1b[38;2;231;237;247m${payload}\x1b[0m` +
      '\x1b[?2026l'
    )
  })
  return measureRendererDuringFrames(page, paneKey, frames)
}

async function measureRendererDuringRewriteBurst(
  page: Page,
  paneKey: string
): Promise<BurstMeasurement> {
  const frames = Array.from({ length: REWRITE_REDRAW_FRAME_COUNT }, (_, frame) => {
    const text = `• Working ${String(frame).padStart(4, '0')}`
    const payload = 'x'.repeat(REWRITE_REDRAW_PAYLOAD_CHARS)
    return `\r\x1b[2K${text} ${payload}`
  })
  return measureRendererDuringFrames(page, paneKey, frames)
}

async function measureRendererDuringFrames(
  page: Page,
  paneKey: string,
  frames: string[]
): Promise<BurstMeasurement> {
  return page.evaluate(
    async ({ paneKey, sampleMs, frames }) => {
      const injector = (window as SchedulerDebugWindow).__terminalPtyDataInjection
      if (!injector) {
        throw new Error('terminal PTY data injection API is unavailable')
      }

      let maxTimerDriftMs = 0
      let samples = 0
      let lastTick = performance.now()
      const startedAt = lastTick
      const timer = window.setInterval(() => {
        const now = performance.now()
        maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTick - sampleMs)
        lastTick = now
        samples += 1
      }, sampleMs)

      let injectedFrames = 0
      for (const data of frames) {
        if (data.length > 2048) {
          throw new Error(`repro frame unexpectedly exceeded 2048 chars: ${data.length}`)
        }
        if (!injector.inject(paneKey, data)) {
          throw new Error(`no PTY data injector registered for pane key ${paneKey}`)
        }
        injectedFrames += 1
      }
      await new Promise((resolve) => window.setTimeout(resolve, sampleMs * 2))
      window.clearInterval(timer)

      return {
        elapsedMs: performance.now() - startedAt,
        injectedFrames,
        maxTimerDriftMs,
        samples
      }
    },
    {
      paneKey,
      sampleMs: TIMER_SAMPLE_MS,
      frames
    }
  )
}

async function installActivePaneRefreshProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as RefreshProbeWindow).__terminalRefreshProbe?.dispose()
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane is unavailable')
    }
    const terminal = pane.terminal as unknown as {
      _core?: { refresh?: (start: number, end: number, sync?: boolean) => void }
      refresh: (start: number, end: number) => void
    }
    const originalCoreRefresh = terminal._core?.refresh?.bind(terminal._core)
    const originalPublicRefresh = terminal.refresh.bind(terminal)
    if (!terminal._core || !originalCoreRefresh) {
      throw new Error('Active terminal core refresh hook is unavailable')
    }
    let synchronousWebgl = 0
    let synchronousDom = 0
    let debouncedWebgl = 0
    let debouncedDom = 0
    terminal._core.refresh = (start, end, sync) => {
      if (sync === true) {
        if (manager.hasWebglRenderer(pane.id)) {
          synchronousWebgl += 1
        } else {
          synchronousDom += 1
        }
      }
      originalCoreRefresh(start, end, sync)
    }
    terminal.refresh = (start, end) => {
      if (manager.hasWebglRenderer(pane.id)) {
        debouncedWebgl += 1
      } else {
        debouncedDom += 1
      }
      originalPublicRefresh(start, end)
    }
    ;(window as RefreshProbeWindow).__terminalRefreshProbe = {
      snapshot: () => ({
        synchronousWebgl,
        synchronousDom,
        debouncedWebgl,
        debouncedDom
      }),
      dispose: () => {
        if (terminal._core) {
          terminal._core.refresh = originalCoreRefresh
        }
        terminal.refresh = originalPublicRefresh
        delete (window as RefreshProbeWindow).__terminalRefreshProbe
      }
    }
  })
}

async function forceActivePaneWebglRenderer(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.settings) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({
      settings: { ...state.settings, terminalGpuAcceleration: 'on' }
    })
    const worktreeId = state.activeWorktreeId
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    window.__paneManagers?.get(tabId ?? '')?.setTerminalGpuAcceleration?.('on')
  })
  return page
    .waitForFunction(
      () => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        const tabId =
          state?.activeTabType === 'terminal'
            ? state.activeTabId
            : worktreeId
              ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
              : null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        return pane ? manager?.hasWebglRenderer(pane.id) === true : false
      },
      null,
      { timeout: 10_000 }
    )
    .then(() => true)
    .catch(() => false)
}

async function readRefreshProbe(page: Page): Promise<RefreshProbeSnapshot> {
  return page.evaluate(
    () =>
      (window as RefreshProbeWindow).__terminalRefreshProbe?.snapshot() ?? {
        synchronousWebgl: 0,
        synchronousDom: 0,
        debouncedWebgl: 0,
        debouncedDom: 0
      }
  )
}

function subtractRefreshProbe(
  current: RefreshProbeSnapshot,
  baseline: RefreshProbeSnapshot
): RefreshProbeSnapshot {
  return {
    synchronousWebgl: current.synchronousWebgl - baseline.synchronousWebgl,
    synchronousDom: current.synchronousDom - baseline.synchronousDom,
    debouncedWebgl: current.debouncedWebgl - baseline.debouncedWebgl,
    debouncedDom: current.debouncedDom - baseline.debouncedDom
  }
}

async function disposeActivePaneRefreshProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as RefreshProbeWindow).__terminalRefreshProbe?.dispose()
  })
}

function loadCapturedOpenCodeSmallRedrawFrames(): string[] {
  if (!existsSync(OPENCODE_CAPTURE_PATH)) {
    return []
  }
  const capture = readFileSync(OPENCODE_CAPTURE_PATH, 'utf8')
  const smallFrames = capture
    .split('\x1b[?2026h')
    .slice(1)
    .map((segment) => `\x1b[?2026h${segment}`)
    .filter((segment) => segment.length <= 2048 && segment.includes('\x1b['))

  const frames: string[] = []
  let totalChars = 0
  while (smallFrames.length > 0 && totalChars <= OPENCODE_CAPTURE_REPLAY_CHARS) {
    for (const frame of smallFrames) {
      frames.push(frame)
      totalChars += frame.length
      if (totalChars > OPENCODE_CAPTURE_REPLAY_CHARS) {
        break
      }
    }
  }
  return frames
}

function annotateMeasurement(
  testInfo: TestInfo,
  measurement: BurstMeasurement,
  scheduler: SchedulerDebugSnapshot
): void {
  testInfo.annotations.push({
    type: 'foreground-redraw-repro',
    description: `elapsed=${measurement.elapsedMs.toFixed(1)}ms maxTimerDrift=${measurement.maxTimerDriftMs.toFixed(
      1
    )}ms samples=${measurement.samples} foregroundWrites=${scheduler.foregroundWriteCount} deferredForegroundEnqueues=${
      scheduler.deferredForegroundEnqueueCount
    } deferredForegroundWrites=${scheduler.deferredForegroundWriteCount} scheduledDrains=${
      scheduler.scheduledDrainCount
    }`
  })
}

test.describe('Terminal foreground redraw freeze repro', () => {
  test('Codex-style line rewrites request a visible row refresh', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
    await waitForTerminalPtyDataInjector(orcaPage, paneKey)
    const webglAttached = await forceActivePaneWebglRenderer(orcaPage)
    // Why: Linux headless CI intentionally disables GPU. Declare that
    // environment unsupported instead of weakening the WebGL-only oracle.
    test.skip(!webglAttached, 'WebGL is unavailable for the refresh-policy probe')
    if (!webglAttached) {
      return
    }
    await installActivePaneRefreshProbe(orcaPage)
    try {
      const refreshBaseline = await readRefreshProbe(orcaPage)
      await resetSchedulerDebug(orcaPage)
      const measurement = await measureRendererDuringRewriteBurst(orcaPage, paneKey)
      const scheduler = await readSchedulerDebug(orcaPage)

      expect(measurement.injectedFrames).toBe(REWRITE_REDRAW_FRAME_COUNT)
      expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_RENDERER_TIMER_DRIFT_MS)
      expect(scheduler.deferredForegroundEnqueueCount).toBeGreaterThan(0)
      await expect
        .poll(
          async () => {
            const refresh = await readRefreshProbe(orcaPage)
            const delta = subtractRefreshProbe(refresh, refreshBaseline)
            return Object.values(delta).reduce((total, count) => total + count, 0)
          },
          {
            timeout: 5_000,
            message: 'Codex-style terminal rewrites did not request an xterm refresh'
          }
        )
        .toBeGreaterThan(0)
      const refresh = await readRefreshProbe(orcaPage)
      const refreshDelta = subtractRefreshProbe(refresh, refreshBaseline)
      testInfo.annotations.push({
        type: 'terminal-refresh-probe',
        description: `syncWebgl=${refreshDelta.synchronousWebgl} syncDom=${
          refreshDelta.synchronousDom
        } debouncedWebgl=${refreshDelta.debouncedWebgl} debouncedDom=${refreshDelta.debouncedDom}`
      })
      // Why: a synchronous full-grid WebGL refresh duplicates xterm's
      // already-queued animation frame and was the #6655 CPU hotspot.
      expect(refreshDelta.synchronousWebgl).toBe(0)
      // Requiring an observed public WebGL refresh prevents a mid-run DOM
      // fallback from turning the zero-sync assertion into a vacuous pass.
      expect(refreshDelta.debouncedWebgl).toBeGreaterThan(0)
    } finally {
      await disposeActivePaneRefreshProbe(orcaPage)
    }
  })

  test('active OpenTUI-style redraw bursts do not monopolize the renderer', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
    await waitForTerminalPtyDataInjector(orcaPage, paneKey)
    await resetSchedulerDebug(orcaPage)
    const measurement = await measureRendererDuringBurst(orcaPage, paneKey)
    const scheduler = await readSchedulerDebug(orcaPage)
    annotateMeasurement(testInfo, measurement, scheduler)

    expect(measurement.injectedFrames).toBe(REDRAW_FRAME_COUNT)
    expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_RENDERER_TIMER_DRIFT_MS)
    // Why: this is the PR #4558 contract. Once the foreground immediate budget
    // is exhausted, throughput redraws must enter the async foreground drain.
    expect(scheduler.deferredForegroundEnqueueCount).toBeGreaterThan(0)
  })

  test('captured OpenCode/OpenTUI redraw bytes do not monopolize foreground writes', async ({
    orcaPage
  }, testInfo) => {
    const frames = loadCapturedOpenCodeSmallRedrawFrames()
    test.skip(
      frames.length === 0,
      `OpenCode PTY capture missing; run "git clone https://github.com/anomalyco/opencode.git .tmp/opencode" then "node tests/e2e/capture-opencode-tui-repro.mjs" to generate ${OPENCODE_CAPTURE_PATH}`
    )

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
    await waitForTerminalPtyDataInjector(orcaPage, paneKey)
    await resetSchedulerDebug(orcaPage)
    const measurement = await measureRendererDuringFrames(orcaPage, paneKey, frames)
    const scheduler = await readSchedulerDebug(orcaPage)
    annotateMeasurement(testInfo, measurement, scheduler)

    expect(measurement.injectedFrames).toBe(frames.length)
    expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_RENDERER_TIMER_DRIFT_MS)
    expect(scheduler.deferredForegroundEnqueueCount).toBeGreaterThan(0)
  })
})
