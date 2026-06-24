import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { writePtyInputAccepted } from './helpers/terminal-accepted-input'
import {
  focusTerminalInputForPtyId,
  terminalOutputIncludesMarker
} from './helpers/terminal-pty-content'
import { runHiddenRealPtyPressureScenario } from './artificial-opencode-hidden-pressure-scenario'
import { runMainPressureScenario } from './artificial-opencode-main-pressure-scenario'
import { startSyntheticOpenCodeInjection } from './artificial-opencode-synthetic-injection'
import {
  startTerminalMarkerWatch,
  waitForMarkerLatency
} from './artificial-opencode-terminal-marker-watch'
import {
  ensureActiveWorktreePaneLoad,
  focusPane,
  holdTerminalAckGate,
  readMainPtyPressureDebug,
  readTerminalAckGateDebug,
  readTerminalOutputSchedulerDebug,
  readTerminalPtyOutputDebug,
  releaseTerminalAckGate,
  resetTerminalPtyOutputDebug,
  waitForMainPtyPressureBacklog,
  writeInteractivePromptScript
} from './artificial-opencode-terminal-load-controls'
import type {
  MainPtyPressureDebugSnapshot,
  TerminalOutputSchedulerDebugSnapshot,
  TerminalPtyAckGateSnapshot,
  TerminalPtyOutputDebugSnapshot
} from './artificial-opencode-terminal-load-controls'

type TypingMeasurement = {
  latencies: number[]
  medianLatencyMs: number
  worstLatencyMs: number
  maxTimerDriftMs: number
  frameCount: number
}

type SyntheticOpenCodeWindow = Window & {
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string) => boolean
  }
  __syntheticOpenCodeLoadState?: {
    pendingTimers?: number[]
    quietUntil?: number
  }
}

const KEY_LATENCY_SAMPLES = 'abcdefghijklmnop'
const DEFAULT_SAME_WORKSPACE_PANES = 5
const DEFAULT_CROSS_WORKSPACE_PANES_PER_WORKTREE = 3
const DEFAULT_PRESSURE_BACKGROUND_PANES = 17
const DEFAULT_PRESSURE_OUTPUT_CHARS = 768 * 1024
const DEFAULT_HIDDEN_PRESSURE_PANES = 17
const HIDDEN_PRESSURE_START_DELAY_MS = 1200
const DEFAULT_FRAME_COUNT = 180
const DEFAULT_FRAME_INTERVAL_MS = 6
const TIMER_SAMPLE_MS = 16
// Why: these are regression budgets, not observed baselines. Repeated local
// 100-pane OpenCode-scale runs are below 50ms worst-key latency; keep enough
// CI headroom while still failing changes that make typing visibly sluggish.
const MAX_WORST_KEY_LATENCY_MS = 300
// Why: synthetic same-workspace redraw storms can produce isolated Electron
// headless key outliers even when median latency, timer drift, and queues stay
// bounded. Keep the wider worst-key ceiling scoped to redraw-storm scenarios.
const MAX_SYNTHETIC_REDRAW_MEDIAN_KEY_LATENCY_MS = 150
const MAX_SYNTHETIC_REDRAW_WORST_KEY_LATENCY_MS = 1000
// Why: ACK-gated real PTYs can briefly contend in the OS PTY/process layer
// even after main/renderer backpressure keeps queues bounded.
const MAX_ACK_PRESSURE_MEDIAN_KEY_LATENCY_MS = 750
const MAX_ACK_PRESSURE_WORST_KEY_LATENCY_MS = 5000
const MAX_ACK_PRESSURE_SCROLL_LATENCY_MS = 300
// Why: hidden real PTY pressure can briefly contend with shell scheduling even
// after renderer/main backpressure works; keep the wider budget scenario-local.
const MAX_HIDDEN_REAL_PTY_WORST_KEY_LATENCY_MS = 500
// Why: GitHub's two-worker Electron shards can briefly starve renderer timers
// without visible typing lag. Keep this as a smoke gate, not a CPU lottery.
const MAX_TIMER_DRIFT_MS = 250
const SYNTHETIC_POST_INPUT_QUIET_MS = 750

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function readPositiveIntList(name: string): number[] {
  const raw = process.env[name]
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value, index, values) => {
      return Number.isInteger(value) && value > 1 && values.indexOf(value) === index
    })
}

const SAME_WORKSPACE_PANES = readPositiveInt(
  'ORCA_E2E_OPENCODE_SAME_WORKSPACE_PANES',
  DEFAULT_SAME_WORKSPACE_PANES
)
const CROSS_WORKSPACE_PANES_PER_WORKTREE = readPositiveInt(
  'ORCA_E2E_OPENCODE_CROSS_WORKSPACE_PANES',
  DEFAULT_CROSS_WORKSPACE_PANES_PER_WORKTREE
)
const PRESSURE_BACKGROUND_PANES = readPositiveInt(
  'ORCA_E2E_OPENCODE_PRESSURE_BACKGROUND_PANES',
  DEFAULT_PRESSURE_BACKGROUND_PANES
)
const PRESSURE_OUTPUT_CHARS = readPositiveInt(
  'ORCA_E2E_OPENCODE_PRESSURE_OUTPUT_CHARS',
  DEFAULT_PRESSURE_OUTPUT_CHARS
)
const HIDDEN_PRESSURE_PANES = readPositiveInt(
  'ORCA_E2E_OPENCODE_HIDDEN_PRESSURE_PANES',
  DEFAULT_HIDDEN_PRESSURE_PANES
)
const FRAME_COUNT = readPositiveInt('ORCA_E2E_OPENCODE_FRAME_COUNT', DEFAULT_FRAME_COUNT)
const FRAME_INTERVAL_MS = readPositiveInt(
  'ORCA_E2E_OPENCODE_FRAME_INTERVAL_MS',
  DEFAULT_FRAME_INTERVAL_MS
)
const SCALE_SAME_WORKSPACE_PANES = readPositiveIntList('ORCA_E2E_OPENCODE_SCALE_PANES')
const SCALE_CROSS_WORKSPACE_PANES = readPositiveIntList(
  'ORCA_E2E_OPENCODE_SCALE_CROSS_WORKSPACE_PANES'
)
const SCALE_PRESSURE_PANES = readPositiveIntList('ORCA_E2E_OPENCODE_SCALE_PRESSURE_PANES')
const SCALE_HIDDEN_PRESSURE_PANES = readPositiveIntList(
  'ORCA_E2E_OPENCODE_SCALE_HIDDEN_PRESSURE_PANES'
)

async function waitForTerminalOutputForPtyId(
  page: Page,
  ptyId: string,
  expected: string,
  timeoutMs: number
): Promise<void> {
  await expect
    .poll(async () => terminalOutputIncludesMarker(page, ptyId, expected, true), {
      timeout: timeoutMs,
      message: `Terminal PTY ${ptyId} did not contain "${expected}"`
    })
    .toBe(true)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function measureTypingDuringLoad(
  page: Page,
  scriptPath: string,
  ptyId: string,
  runId: string,
  inputMethod: 'keyboard' | 'ptyWrite' | 'terminalInput' = 'keyboard',
  maxWorstKeyLatencyMs = MAX_WORST_KEY_LATENCY_MS
): Promise<TypingMeasurement> {
  await prepareTypingPrompt(page, scriptPath, ptyId, runId)
  return measureReadyPromptTyping(page, ptyId, runId, inputMethod, maxWorstKeyLatencyMs)
}

async function prepareTypingPrompt(
  page: Page,
  scriptPath: string,
  ptyId: string,
  runId: string
): Promise<void> {
  await focusTerminalInputForPtyId(page, ptyId)
  const command = `node ${JSON.stringify(`./${path.basename(scriptPath)}`)}`
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await writePtyInputAccepted(page, ptyId, `${attempt === 0 ? '\x15' : '\x03\x15'}${command}\r`)
    try {
      await waitForTerminalOutputForPtyId(page, ptyId, `OPENCODE_TYPING_READY_${runId}`, 10_000)
      lastError = null
      break
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) {
    const pressure = await readMainPtyPressureDebug(page)
    throw new Error(
      `${lastError instanceof Error ? lastError.message : String(lastError)}\n${JSON.stringify(
        pressure
      )}`
    )
  }
  await focusTerminalInputForPtyId(page, ptyId)
  await waitForActiveRendererPtyHint(page)
  // Why: READY proves the prompt emitted output, but the child process can still
  // be between stdout flush and the next stdin turn under heavy pane setup.
  await page.waitForTimeout(50)
}

async function measureReadyPromptTyping(
  page: Page,
  ptyId: string,
  runId: string,
  inputMethod: 'keyboard' | 'ptyWrite' | 'terminalInput' = 'keyboard',
  maxWorstKeyLatencyMs = MAX_WORST_KEY_LATENCY_MS
): Promise<TypingMeasurement> {
  const eventLoop = await page.evaluateHandle((sampleMs) => {
    let maxTimerDriftMs = 0
    let lastTick = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTick - sampleMs)
      lastTick = now
    }, sampleMs)
    return {
      stop: () => {
        window.clearInterval(timer)
        return maxTimerDriftMs
      }
    }
  }, TIMER_SAMPLE_MS)

  const latencies: number[] = []
  for (const [index, char] of [...KEY_LATENCY_SAMPLES].entries()) {
    const marker = `OPENCODE_TYPING_KEY_${runId}_${index + 1}`
    await focusTerminalInputForPtyId(page, ptyId)
    await waitForActiveRendererPtyHint(page)
    const watchId = randomUUID()
    await startTerminalMarkerWatch(page, ptyId, marker, maxWorstKeyLatencyMs, watchId)
    await recordSyntheticOpenCodeTypingInput(page)
    if (inputMethod === 'ptyWrite') {
      const accepted = await page.evaluate(
        ({ char, ptyId }) => window.api.pty.writeAccepted(ptyId, char),
        { char, ptyId }
      )
      if (!accepted) {
        throw new Error(`PTY input write was rejected for ${ptyId}`)
      }
    } else if (inputMethod === 'terminalInput') {
      // Why: this real-PTY pressure repro needs xterm's onData path so renderer
      // input-latency bookkeeping runs, but DOM keyboard events can be dropped
      // under the synthetic split-pane storm even when the textarea is focused.
      await page.evaluate(
        ({ char, ptyId: targetPtyId }) => {
          for (const manager of window.__paneManagers?.values() ?? []) {
            for (const pane of manager.getPanes?.() ?? []) {
              if (pane.container?.dataset?.ptyId === targetPtyId) {
                pane.terminal.input(char, true)
                return
              }
            }
          }
          throw new Error(`Terminal PTY ${targetPtyId} is unavailable for input`)
        },
        { char, ptyId }
      )
    } else {
      await page.keyboard.type(char)
    }
    latencies.push(
      await waitForMarkerLatency(
        page,
        ptyId,
        marker,
        maxWorstKeyLatencyMs,
        watchId,
        readMainPtyPressureDebug
      )
    )
  }

  const maxTimerDriftMs = await eventLoop.evaluate((watcher) => watcher.stop())
  await eventLoop.dispose()
  return {
    latencies,
    medianLatencyMs: median(latencies),
    worstLatencyMs: Math.max(...latencies),
    maxTimerDriftMs,
    frameCount: FRAME_COUNT
  }
}

async function recordSyntheticOpenCodeTypingInput(page: Page): Promise<void> {
  await page.evaluate((quietMs) => {
    const state = (window as SyntheticOpenCodeWindow).__syntheticOpenCodeLoadState
    if (!state) {
      return
    }
    state.quietUntil = Math.max(state.quietUntil ?? 0, performance.now() + quietMs)
    for (const timer of state.pendingTimers ?? []) {
      window.clearTimeout(timer)
    }
    state.pendingTimers = []
  }, SYNTHETIC_POST_INPUT_QUIET_MS)
}

async function waitForActiveRendererPtyHint(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readMainPtyPressureDebug(page))?.activeRendererPtyCount ?? 0, {
      timeout: 5_000,
      message: 'main process did not receive the focused renderer PTY hint'
    })
    .toBe(1)
}

function annotateTypingMeasurement(
  testInfo: TestInfo,
  type: string,
  paneCount: number,
  measurement: TypingMeasurement,
  debug: TerminalPtyOutputDebugSnapshot | null = null,
  scheduler: TerminalOutputSchedulerDebugSnapshot | null = null,
  mainPressure: MainPtyPressureDebugSnapshot | null = null,
  ackGate: TerminalPtyAckGateSnapshot | null = null
): void {
  const hiddenSkipSummary = debug
    ? ` hiddenSkips=${debug.hiddenRendererSkipCount} hiddenSkippedChars=${debug.hiddenRendererSkippedChars} mode2031Replies=${debug.hiddenRendererMode2031ReplyCount}`
    : ''
  const schedulerSummary = scheduler
    ? ` deferredForegroundEnqueue=${scheduler.deferredForegroundEnqueueCount} deferredForegroundWrite=${scheduler.deferredForegroundWriteCount} scheduledDrains=${scheduler.scheduledDrainCount} rendererQueuedTerminals=${scheduler.queuedTerminalCount} rendererQueuedChars=${scheduler.queuedChars} rendererPeakQueuedTerminals=${scheduler.peakQueuedTerminalCount} rendererPeakQueuedChars=${scheduler.peakQueuedChars} rendererPeakQueuedCharsByTerminal=${scheduler.peakQueuedCharsByTerminal} rendererDroppedBacklogs=${scheduler.droppedBacklogCount}`
    : ''
  const mainPressureSummary = mainPressure
    ? ` mainPendingPtys=${mainPressure.pendingPtyCount} mainPendingChars=${mainPressure.pendingChars} mainMaxPendingChars=${mainPressure.maxPendingCharsByPty} mainInFlightPtys=${mainPressure.rendererInFlightPtyCount} mainInFlightChars=${mainPressure.rendererInFlightChars} mainMaxInFlightChars=${mainPressure.maxRendererInFlightCharsByPty} mainActivePtys=${mainPressure.activeRendererPtyCount} mainSourcePausedPtys=${mainPressure.sourcePausedPtyCount} mainInputPtys=${mainPressure.inputTrackedPtyCount} mainLatestInputAgeMs=${mainPressure.latestInputAgeMs ?? 'none'} mainFlushScheduled=${mainPressure.flushScheduled} mainPeakPendingChars=${mainPressure.peakPendingChars} mainPeakMaxPendingChars=${mainPressure.peakMaxPendingCharsByPty} mainPeakInFlightChars=${mainPressure.peakRendererInFlightChars} mainPeakMaxInFlightChars=${mainPressure.peakMaxRendererInFlightCharsByPty} mainAckGatedFlushSkips=${mainPressure.ackGatedFlushSkipCount}`
    : ''
  const ackGateSummary = ackGate
    ? ` heldAckPtys=${ackGate.heldAckCount} heldAckChars=${ackGate.heldAckChars} gatedAckPtys=${ackGate.gatedPtyCount}`
    : ''
  testInfo.annotations.push({
    type,
    description: `panes=${paneCount} frames=${measurement.frameCount} median=${measurement.medianLatencyMs.toFixed(
      1
    )}ms worst=${measurement.worstLatencyMs.toFixed(
      1
    )}ms maxTimerDrift=${measurement.maxTimerDriftMs.toFixed(1)}ms samples=${measurement.latencies
      .map((value) => value.toFixed(1))
      .join(',')}${hiddenSkipSummary}${schedulerSummary}${mainPressureSummary}${ackGateSummary}`
  })
}

async function measureCrossWorkspaceTypingDuringHiddenLoad({
  orcaPage,
  testRepoPath,
  hiddenPaneCount,
  annotationType,
  testInfo
}: {
  orcaPage: Page
  testRepoPath: string
  hiddenPaneCount: number
  annotationType: string
  testInfo: TestInfo
}): Promise<void> {
  await waitForSessionReady(orcaPage)
  const firstWorktreeId = await waitForActiveWorktree(orcaPage)
  const allWorktreeIds = await getAllWorktreeIds(orcaPage)
  const secondWorktreeId = allWorktreeIds.find((id) => id !== firstWorktreeId)
  test.skip(!secondWorktreeId, 'OpenCode cross-workspace load needs the seeded secondary worktree')
  if (!secondWorktreeId) {
    return
  }

  await switchToWorktree(orcaPage, secondWorktreeId)
  const hiddenPanes = await ensureActiveWorktreePaneLoad(orcaPage, hiddenPaneCount)

  await switchToWorktree(orcaPage, firstWorktreeId)
  await expect.poll(() => getActiveWorktreeId(orcaPage), { timeout: 10_000 }).toBe(firstWorktreeId)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const typingPtyId = await waitForActivePanePtyId(orcaPage)

  const runId = randomUUID()
  const scriptPath = path.join(testRepoPath, `.orca-opencode-cross-${hiddenPaneCount}-${runId}.mjs`)
  writeInteractivePromptScript(scriptPath, runId)
  await resetTerminalPtyOutputDebug(orcaPage)
  const load = await startSyntheticOpenCodeInjection({
    frameCount: FRAME_COUNT,
    intervalMs: FRAME_INTERVAL_MS,
    page: orcaPage,
    paneKeys: hiddenPanes.map((pane) => pane.paneKey)
  })
  try {
    const measurement = await measureTypingDuringLoad(
      orcaPage,
      scriptPath,
      typingPtyId,
      runId,
      'terminalInput'
    )
    const debug = await readTerminalPtyOutputDebug(orcaPage)
    const scheduler = await readTerminalOutputSchedulerDebug(orcaPage)
    const mainPressure = await readMainPtyPressureDebug(orcaPage)
    annotateTypingMeasurement(
      testInfo,
      annotationType,
      hiddenPanes.length + 1,
      measurement,
      debug,
      scheduler,
      mainPressure
    )
    expect(debug?.hiddenRendererSkipCount ?? 0).toBe(0)
    expect(debug?.hiddenRendererSkippedChars ?? 0).toBe(0)
    expect(measurement.medianLatencyMs).toBeLessThan(MAX_SYNTHETIC_REDRAW_MEDIAN_KEY_LATENCY_MS)
    expect(measurement.worstLatencyMs).toBeLessThan(MAX_SYNTHETIC_REDRAW_WORST_KEY_LATENCY_MS)
    expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_TIMER_DRIFT_MS)
  } finally {
    await load.stop()
    await sendToTerminal(orcaPage, typingPtyId, '\x03').catch(() => undefined)
    rmSync(scriptPath, { force: true })
  }
}

async function runConfiguredMainPressureScenario({
  annotationSuffix,
  backgroundPaneCount,
  orcaPage,
  testInfo,
  testRepoPath
}: {
  annotationSuffix: string
  backgroundPaneCount: number
  orcaPage: Page
  testInfo: TestInfo
  testRepoPath: string
}): Promise<void> {
  await runMainPressureScenario({
    annotationSuffix,
    backgroundPaneCount,
    orcaPage,
    pressureOutputChars: PRESSURE_OUTPUT_CHARS,
    testInfo,
    testRepoPath,
    maxMedianKeyLatencyMs: MAX_ACK_PRESSURE_MEDIAN_KEY_LATENCY_MS,
    maxScrollLatencyMs: MAX_ACK_PRESSURE_SCROLL_LATENCY_MS,
    maxTimerDriftMs: MAX_TIMER_DRIFT_MS,
    maxWorstKeyLatencyMs: MAX_ACK_PRESSURE_WORST_KEY_LATENCY_MS,
    deps: {
      annotateTypingMeasurement,
      ensureActiveWorktreePaneLoad,
      focusPane,
      holdTerminalAckGate,
      measureReadyPromptTyping,
      measureTypingDuringLoad,
      prepareTypingPrompt,
      readMainPtyPressureDebug,
      readTerminalAckGateDebug,
      readTerminalOutputSchedulerDebug,
      readTerminalPtyOutputDebug,
      releaseTerminalAckGate,
      resetTerminalPtyOutputDebug,
      waitForActiveWorktree,
      waitForMainPtyPressureBacklog,
      waitForSessionReady,
      writeInteractivePromptScript
    }
  })
}

test.describe('Artificial OpenCode terminal load', () => {
  test.describe.configure({ mode: 'serial' })

  test('measures baseline typing responsiveness with one active terminal', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const typingPtyId = await waitForActivePanePtyId(orcaPage)

    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-opencode-baseline-typing-${runId}.mjs`)
    writeInteractivePromptScript(scriptPath, runId)
    await resetTerminalPtyOutputDebug(orcaPage)
    try {
      const measurement = await measureTypingDuringLoad(
        orcaPage,
        scriptPath,
        typingPtyId,
        runId,
        'terminalInput'
      )
      const debug = await readTerminalPtyOutputDebug(orcaPage)
      const scheduler = await readTerminalOutputSchedulerDebug(orcaPage)
      const mainPressure = await readMainPtyPressureDebug(orcaPage)
      annotateTypingMeasurement(
        testInfo,
        'opencode-baseline-typing',
        1,
        measurement,
        debug,
        scheduler,
        mainPressure
      )
      expect(measurement.medianLatencyMs).toBeLessThan(MAX_SYNTHETIC_REDRAW_MEDIAN_KEY_LATENCY_MS)
      expect(measurement.worstLatencyMs).toBeLessThan(MAX_SYNTHETIC_REDRAW_WORST_KEY_LATENCY_MS)
      expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_TIMER_DRIFT_MS)
    } finally {
      await sendToTerminal(orcaPage, typingPtyId, '\x03').catch(() => undefined)
      rmSync(scriptPath, { force: true })
    }
  })

  test('keeps typing responsive while same-workspace panes redraw simultaneously', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const [initialTypingPane] = await ensureActiveWorktreePaneLoad(orcaPage, 1)
    if (!initialTypingPane) {
      throw new Error('Active typing pane was not created')
    }
    await focusPane(orcaPage, initialTypingPane.paneKey)

    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-opencode-typing-${runId}.mjs`)
    writeInteractivePromptScript(scriptPath, runId)
    await resetTerminalPtyOutputDebug(orcaPage)
    await prepareTypingPrompt(orcaPage, scriptPath, initialTypingPane.ptyId, runId)
    const panes = await ensureActiveWorktreePaneLoad(orcaPage, SAME_WORKSPACE_PANES)
    const typingPane =
      panes.find((pane) => pane.ptyId === initialTypingPane.ptyId) ?? initialTypingPane
    const loadPanes = panes.filter((pane) => pane.ptyId !== typingPane.ptyId)
    await focusPane(orcaPage, typingPane.paneKey)
    const load = await startSyntheticOpenCodeInjection({
      frameCount: FRAME_COUNT,
      intervalMs: FRAME_INTERVAL_MS,
      page: orcaPage,
      paneKeys: loadPanes.map((pane) => pane.paneKey)
    })
    try {
      const measurement = await measureReadyPromptTyping(
        orcaPage,
        typingPane.ptyId,
        runId,
        'terminalInput'
      )
      annotateTypingMeasurement(
        testInfo,
        'opencode-same-workspace-typing',
        panes.length,
        measurement,
        await readTerminalPtyOutputDebug(orcaPage),
        await readTerminalOutputSchedulerDebug(orcaPage),
        await readMainPtyPressureDebug(orcaPage)
      )
      expect(measurement.medianLatencyMs).toBeLessThan(MAX_SYNTHETIC_REDRAW_MEDIAN_KEY_LATENCY_MS)
      expect(measurement.worstLatencyMs).toBeLessThan(MAX_SYNTHETIC_REDRAW_WORST_KEY_LATENCY_MS)
      expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_TIMER_DRIFT_MS)
    } finally {
      await load.stop()
      await sendToTerminal(orcaPage, typingPane.ptyId, '\x03').catch(() => undefined)
      rmSync(scriptPath, { force: true })
    }
  })

  test('keeps active typing responsive while background PTYs are ACK-backpressured', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runConfiguredMainPressureScenario({
      orcaPage,
      testRepoPath,
      backgroundPaneCount: PRESSURE_BACKGROUND_PANES,
      annotationSuffix: '',
      testInfo
    })
  })

  for (const paneCount of SCALE_PRESSURE_PANES) {
    test(`keeps active interactions responsive at ${paneCount} ACK-backpressured OpenCode PTYs`, async ({
      orcaPage,
      testRepoPath
    }, testInfo) => {
      await runConfiguredMainPressureScenario({
        orcaPage,
        testRepoPath,
        backgroundPaneCount: paneCount,
        annotationSuffix: `-${paneCount}`,
        testInfo
      })
    })
  }

  for (const paneCount of SCALE_SAME_WORKSPACE_PANES) {
    test(`keeps typing responsive at ${paneCount} same-workspace OpenCode panes`, async ({
      orcaPage,
      testRepoPath
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const [initialTypingPane] = await ensureActiveWorktreePaneLoad(orcaPage, 1)
      if (!initialTypingPane) {
        throw new Error('Active typing pane was not created')
      }
      await focusPane(orcaPage, initialTypingPane.paneKey)

      const runId = randomUUID()
      const scriptPath = path.join(testRepoPath, `.orca-opencode-scale-${paneCount}-${runId}.mjs`)
      writeInteractivePromptScript(scriptPath, runId)
      await resetTerminalPtyOutputDebug(orcaPage)
      await prepareTypingPrompt(orcaPage, scriptPath, initialTypingPane.ptyId, runId)
      const panes = await ensureActiveWorktreePaneLoad(orcaPage, paneCount)
      const typingPane =
        panes.find((pane) => pane.ptyId === initialTypingPane.ptyId) ?? initialTypingPane
      const loadPanes = panes.filter((pane) => pane.ptyId !== typingPane.ptyId)
      await focusPane(orcaPage, typingPane.paneKey)
      const load = await startSyntheticOpenCodeInjection({
        frameCount: FRAME_COUNT,
        intervalMs: FRAME_INTERVAL_MS,
        page: orcaPage,
        paneKeys: loadPanes.map((pane) => pane.paneKey)
      })
      try {
        const measurement = await measureReadyPromptTyping(
          orcaPage,
          typingPane.ptyId,
          runId,
          'terminalInput'
        )
        annotateTypingMeasurement(
          testInfo,
          `opencode-scale-same-workspace-${paneCount}`,
          panes.length,
          measurement,
          await readTerminalPtyOutputDebug(orcaPage),
          await readTerminalOutputSchedulerDebug(orcaPage),
          await readMainPtyPressureDebug(orcaPage)
        )
        expect(measurement.medianLatencyMs).toBeLessThan(MAX_SYNTHETIC_REDRAW_MEDIAN_KEY_LATENCY_MS)
        expect(measurement.worstLatencyMs).toBeLessThan(MAX_SYNTHETIC_REDRAW_WORST_KEY_LATENCY_MS)
        expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_TIMER_DRIFT_MS)
      } finally {
        await load.stop()
        await sendToTerminal(orcaPage, typingPane.ptyId, '\x03').catch(() => undefined)
        rmSync(scriptPath, { force: true })
      }
    })
  }

  test('keeps typing responsive while another workspace streams OpenCode-style output', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await measureCrossWorkspaceTypingDuringHiddenLoad({
      orcaPage,
      testRepoPath,
      hiddenPaneCount: CROSS_WORKSPACE_PANES_PER_WORKTREE,
      annotationType: 'opencode-cross-workspace-typing',
      testInfo
    })
  })
  async function runConfiguredHiddenRealPtyPressureScenario(
    orcaPage: Page,
    testRepoPath: string,
    testInfo: TestInfo,
    hiddenPaneCount: number,
    annotationSuffix?: string
  ): Promise<void> {
    await runHiddenRealPtyPressureScenario({
      orcaPage,
      testRepoPath,
      annotationSuffix,
      hiddenPaneCount,
      pressureOutputChars: PRESSURE_OUTPUT_CHARS,
      pressureStartDelayMs: HIDDEN_PRESSURE_START_DELAY_MS,
      maxWorstKeyLatencyMs: MAX_HIDDEN_REAL_PTY_WORST_KEY_LATENCY_MS,
      testInfo,
      deps: {
        annotateTypingMeasurement,
        ensureActiveWorktreePaneLoad,
        holdTerminalAckGate,
        measureTypingDuringLoad,
        readMainPtyPressureDebug,
        readTerminalAckGateDebug,
        readTerminalOutputSchedulerDebug,
        readTerminalPtyOutputDebug,
        releaseTerminalAckGate,
        resetTerminalPtyOutputDebug,
        waitForMainPtyPressureBacklog,
        writeInteractivePromptScript
      }
    })
  }
  test('keeps typing responsive while hidden real PTYs are ACK-backpressured', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runConfiguredHiddenRealPtyPressureScenario(
      orcaPage,
      testRepoPath,
      testInfo,
      HIDDEN_PRESSURE_PANES
    )
  })
  for (const paneCount of SCALE_HIDDEN_PRESSURE_PANES) {
    test(`keeps hidden restore responsive with ${paneCount} ACK-backpressured real PTYs`, async ({
      orcaPage,
      testRepoPath
    }, testInfo) => {
      await runConfiguredHiddenRealPtyPressureScenario(
        orcaPage,
        testRepoPath,
        testInfo,
        paneCount,
        `-${paneCount}`
      )
    })
  }

  for (const paneCount of SCALE_CROSS_WORKSPACE_PANES) {
    test(`keeps typing responsive with ${paneCount} hidden cross-workspace OpenCode panes`, async ({
      orcaPage,
      testRepoPath
    }, testInfo) => {
      await measureCrossWorkspaceTypingDuringHiddenLoad({
        orcaPage,
        testRepoPath,
        hiddenPaneCount: paneCount,
        annotationType: `opencode-scale-cross-workspace-${paneCount}`,
        testInfo
      })
    })
  }
})
