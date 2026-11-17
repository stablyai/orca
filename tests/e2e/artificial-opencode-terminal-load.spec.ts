import { presentTerminalPerfWindow } from './terminal-perf-presentation'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { sendToTerminal } from './helpers/terminal'
import {
  ensureActiveWorktreePaneLoad,
  focusActiveTerminalInput,
  focusPane,
  waitForMarkerLatency,
  waitForTerminalOutputForPtyId
} from './artificial-opencode-pane-interactions'
import { runHiddenRealPtyPressureScenario } from './artificial-opencode-hidden-pressure-scenario'
import type { HiddenPressureOutputMode } from './artificial-opencode-hidden-pressure-script'
import { runRendererBackpressureRevisitScenario } from './artificial-opencode-revisit-pressure-scenario'

test.beforeEach(async ({ electronApp, orcaPage }, testInfo) => {
  await orcaPage.waitForLoadState('domcontentloaded')
  await presentTerminalPerfWindow(electronApp, testInfo)
})

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
  __terminalPtyAckGate?: {
    hold: (ptyIds: string[]) => void
    release: () => void
    snapshot: () => TerminalPtyAckGateSnapshot
  }
  __terminalPtyOutputDebug?: {
    reset: () => void
    snapshot: () => TerminalPtyOutputDebugSnapshot
  }
  __terminalOutputSchedulerDebug?: {
    reset: () => void
    snapshot: () => TerminalOutputSchedulerDebugSnapshot
  }
}

type TerminalPtyOutputDebugSnapshot = {
  hiddenRendererSkipCount: number
}

type TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: number
  deferredForegroundEnqueueCount: number
  foregroundWriteCount: number
  backgroundWriteCount: number
  deferredForegroundWriteCount: number
  flushWriteCount: number
  scheduledDrainCount: number
  queuedTerminalCount: number
  queuedChars: number
  peakQueuedTerminalCount: number
  peakQueuedChars: number
  peakQueuedCharsByTerminal: number
  droppedBacklogCount: number
  drainWrites: number[]
}

type TerminalPtyAckGateSnapshot = {
  gatedPtyCount: number
  heldAckCount: number
  heldAckChars: number
}

type MainPtyPressureDebugSnapshot = {
  pendingPtyCount: number
  pendingChars: number
  maxPendingCharsByPty: number
  rendererInFlightPtyCount: number
  rendererInFlightChars: number
  maxRendererInFlightCharsByPty: number
  activeRendererPtyCount: number
  flushScheduled: boolean
  peakPendingChars: number
  peakMaxPendingCharsByPty: number
  peakRendererInFlightChars: number
  peakMaxRendererInFlightCharsByPty: number
  ackGatedFlushSkipCount: number
  // Phase-4 hidden-delivery gate: bytes dropped in main after model ingestion.
  hiddenDeliveryGatedPtyCount: number
  deliveryInterestPtyCount: number
  hiddenDeliveryDroppedChars: number
  hiddenDeliveryDroppedChunks: number
  pendingDroppedChars: number
}

const KEY_LATENCY_SAMPLES = 'abcdefghijklmnop'
const DEFAULT_PRESSURE_BACKGROUND_PANES = 17
const DEFAULT_PRESSURE_OUTPUT_CHARS = 768 * 1024
const DEFAULT_HIDDEN_PRESSURE_PANES = 17
const HIDDEN_PRESSURE_START_DELAY_MS = 1200
const DEFAULT_FRAME_COUNT = 180
const MAIN_RENDERER_PRESSURE_TARGET_CHARS = 2 * 1024 * 1024
// Gate visible typing regressions with CI headroom above repeated local sub-50ms echo measurements.
const MAX_MEDIAN_KEY_LATENCY_MS = 75
// Keep median latency strict; worst loaded echo can hit a ~3.1s runner stall and serves only as a hang detector.
const MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS = 3_500
// Revisit printf runs under background pressure plus whole-buffer polling, so it needs the loaded budget.
const MAX_REVISIT_LATENCY_UNDER_LOAD_MS = 3_000
// Loaded timer drift may share ~3.1s runner starvation with worst echo; keep the strict unloaded baseline.
const MAX_TIMER_DRIFT_UNDER_LOAD_MS = 3_500
// Why: byte-level peaks vary by drain quantum; the coarse guard matches the main-pressure scenario.
const MAX_RENDERER_SCHEDULER_QUEUED_CHARS = 5 * 1024 * 1024

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

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

function interactivePromptScript(runId: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
const interrupt = String.fromCharCode(3)
process.stdout.write('\\x1b]0;OpenCode load typing benchmark\\x07')
process.stdout.write('OPENCODE_TYPING_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  for (const char of chunk) {
    if (char === '\\r' || char === '\\n') continue
    seq += 1
    process.stdout.write('\\r\\x1b[2KOpenCode load prompt ' + seq + ': ' + char + ' OPENCODE_TYPING_KEY_${runId}_' + seq + '\\n')
  }
})
`
}

function writeInteractivePromptScript(scriptPath: string, runId: string): void {
  // Use any writable directory: scale-run prompt scripts need no git state and can outlive fixture-repo cleanup.
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, interactivePromptScript(runId))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function measureTypingDuringLoad(
  page: Page,
  scriptPath: string,
  ptyId: string,
  runId: string
): Promise<TypingMeasurement> {
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
  await waitForTerminalOutputForPtyId(page, ptyId, `OPENCODE_TYPING_READY_${runId}`, 10_000)
  await focusActiveTerminalInput(page)

  // Hidden-renderer intervals can drift while echo stays fast; use long tasks to measure actual main-thread blocking.
  const eventLoop = await page.evaluateHandle(() => {
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      throw new Error('Long-task timing is unavailable in this renderer')
    }
    let longestTaskMs = 0
    const record = (entries: PerformanceEntryList): void => {
      for (const entry of entries) {
        longestTaskMs = Math.max(longestTaskMs, entry.duration)
      }
    }
    const observer = new PerformanceObserver((list) => record(list.getEntries()))
    observer.observe({ type: 'longtask' })
    return {
      stop: () => {
        record(observer.takeRecords())
        observer.disconnect()
        return longestTaskMs
      }
    }
  })

  const latencies: number[] = []
  for (const [index, char] of [...KEY_LATENCY_SAMPLES].entries()) {
    const marker = `OPENCODE_TYPING_KEY_${runId}_${index + 1}`
    const start = performance.now()
    await page.keyboard.type(char)
    // Allow the loaded echo budget so slow input becomes a latency failure rather than a missing-output error.
    await waitForMarkerLatency(page, marker, MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS)
    latencies.push(performance.now() - start)
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

async function resetTerminalPtyOutputDebug(page: Page): Promise<void> {
  await page.evaluate(async () => {
    ;(window as SyntheticOpenCodeWindow).__terminalPtyOutputDebug?.reset()
    ;(window as SyntheticOpenCodeWindow).__terminalOutputSchedulerDebug?.reset()
    await window.api.pty.resetRendererDeliveryDebug()
  })
}

async function readTerminalPtyOutputDebug(
  page: Page
): Promise<TerminalPtyOutputDebugSnapshot | null> {
  return page.evaluate(() => {
    return (window as SyntheticOpenCodeWindow).__terminalPtyOutputDebug?.snapshot() ?? null
  })
}

async function readTerminalOutputSchedulerDebug(
  page: Page
): Promise<TerminalOutputSchedulerDebugSnapshot | null> {
  return page.evaluate(() => {
    return (window as SyntheticOpenCodeWindow).__terminalOutputSchedulerDebug?.snapshot() ?? null
  })
}

async function readMainPtyPressureDebug(page: Page): Promise<MainPtyPressureDebugSnapshot | null> {
  return page.evaluate(async () => {
    return window.api.pty.getRendererDeliveryDebugSnapshot()
  })
}

async function holdTerminalAckGate(page: Page, ptyIds: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const gate = (window as SyntheticOpenCodeWindow).__terminalPtyAckGate
    if (!gate) {
      throw new Error('terminal PTY ACK gate is unavailable')
    }
    gate.hold(ids)
  }, ptyIds)
}

async function releaseTerminalAckGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as SyntheticOpenCodeWindow).__terminalPtyAckGate?.release()
  })
}

async function readTerminalAckGateDebug(page: Page): Promise<TerminalPtyAckGateSnapshot | null> {
  return page.evaluate(() => {
    return (window as SyntheticOpenCodeWindow).__terminalPtyAckGate?.snapshot() ?? null
  })
}

async function waitForMainPtyPressureBacklog(page: Page): Promise<MainPtyPressureDebugSnapshot> {
  let lastSnapshot: MainPtyPressureDebugSnapshot | null = null
  await expect
    .poll(
      async () => {
        lastSnapshot = await readMainPtyPressureDebug(page)
        return (
          (lastSnapshot?.peakRendererInFlightChars ?? 0) >= MAIN_RENDERER_PRESSURE_TARGET_CHARS &&
          (lastSnapshot?.peakPendingChars ?? 0) > 0 &&
          (lastSnapshot?.ackGatedFlushSkipCount ?? 0) > 0
        )
      },
      {
        timeout: 20_000,
        message: 'Main PTY renderer delivery pressure did not build up'
      }
    )
    .toBe(true)
  if (!lastSnapshot) {
    throw new Error('Main PTY pressure snapshot unavailable')
  }
  return lastSnapshot
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
  const hiddenSkipSummary = debug ? ` hiddenRendererSkips=${debug.hiddenRendererSkipCount}` : ''
  const schedulerSummary = scheduler
    ? ` deferredForegroundEnqueue=${scheduler.deferredForegroundEnqueueCount} deferredForegroundWrite=${scheduler.deferredForegroundWriteCount} scheduledDrains=${scheduler.scheduledDrainCount} rendererQueuedTerminals=${scheduler.queuedTerminalCount} rendererQueuedChars=${scheduler.queuedChars} rendererPeakQueuedTerminals=${scheduler.peakQueuedTerminalCount} rendererPeakQueuedChars=${scheduler.peakQueuedChars} rendererPeakQueuedCharsByTerminal=${scheduler.peakQueuedCharsByTerminal} rendererDroppedBacklogs=${scheduler.droppedBacklogCount}`
    : ''
  const mainPressureSummary = mainPressure
    ? ` mainPendingPtys=${mainPressure.pendingPtyCount} mainPendingChars=${mainPressure.pendingChars} mainMaxPendingChars=${mainPressure.maxPendingCharsByPty} mainInFlightPtys=${mainPressure.rendererInFlightPtyCount} mainInFlightChars=${mainPressure.rendererInFlightChars} mainMaxInFlightChars=${mainPressure.maxRendererInFlightCharsByPty} mainActivePtys=${mainPressure.activeRendererPtyCount} mainFlushScheduled=${mainPressure.flushScheduled} mainPeakPendingChars=${mainPressure.peakPendingChars} mainPeakMaxPendingChars=${mainPressure.peakMaxPendingCharsByPty} mainPeakInFlightChars=${mainPressure.peakRendererInFlightChars} mainPeakMaxInFlightChars=${mainPressure.peakMaxRendererInFlightCharsByPty} mainAckGatedFlushSkips=${mainPressure.ackGatedFlushSkipCount} mainHiddenGatedPtys=${mainPressure.hiddenDeliveryGatedPtyCount} mainHiddenDroppedChars=${mainPressure.hiddenDeliveryDroppedChars} mainPendingDroppedChars=${mainPressure.pendingDroppedChars}`
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

const terminalLoadScenarioDeps = {
  annotateTypingMeasurement,
  ensureActiveWorktreePaneLoad,
  focusPane,
  holdTerminalAckGate,
  measureTypingDuringLoad,
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

test.describe('Artificial OpenCode terminal load', () => {
  test.describe.configure({ mode: 'serial' })

  test('keeps renderer backpressure bounded across worktree revisit', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runRendererBackpressureRevisitScenario({
      backgroundPaneCount: PRESSURE_BACKGROUND_PANES,
      deps: terminalLoadScenarioDeps,
      mainRendererPressureTargetChars: MAIN_RENDERER_PRESSURE_TARGET_CHARS,
      maxMedianKeyLatencyMs: MAX_MEDIAN_KEY_LATENCY_MS,
      maxRendererSchedulerQueuedChars: MAX_RENDERER_SCHEDULER_QUEUED_CHARS,
      maxRevisitLatencyMs: MAX_REVISIT_LATENCY_UNDER_LOAD_MS,
      // Use loaded worst-echo/drift budgets under background pressure; strict budgets belong to the unloaded baseline.
      maxTimerDriftMs: MAX_TIMER_DRIFT_UNDER_LOAD_MS,
      maxWorstKeyLatencyMs: MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS,
      orcaPage,
      pressureOutputChars: PRESSURE_OUTPUT_CHARS,
      testInfo,
      testRepoPath
    })
  })

  async function runConfiguredHiddenRealPtyPressureScenario(
    orcaPage: Page,
    testRepoPath: string,
    testInfo: TestInfo,
    hiddenPaneCount: number,
    annotationSuffix?: string,
    pressureOutputMode?: HiddenPressureOutputMode
  ): Promise<void> {
    await runHiddenRealPtyPressureScenario({
      orcaPage,
      testRepoPath,
      annotationSuffix,
      hiddenPaneCount,
      pressureOutputChars: PRESSURE_OUTPUT_CHARS,
      pressureOutputMode,
      pressureStartDelayMs: HIDDEN_PRESSURE_START_DELAY_MS,
      testInfo,
      deps: terminalLoadScenarioDeps
    })
  }
  const hiddenPressureCases: {
    title: string
    suffix?: string
    mode?: HiddenPressureOutputMode
  }[] = [
    { title: 'keeps typing responsive while hidden real PTYs are ACK-backpressured' },
    // Assert hidden delivery is withheld in main; renderer skip-scanning was removed.
    {
      title: 'withholds renderer delivery for plain hidden PTY output while preserving restore',
      suffix: '-plain',
      mode: 'plain'
    },
    {
      title: 'withholds renderer delivery for Latin hidden PTY output while preserving restore',
      suffix: '-latin',
      mode: 'latin'
    },
    {
      title:
        'withholds renderer delivery for title-only hidden PTY output while preserving restore',
      suffix: '-title',
      mode: 'title'
    },
    {
      title: 'restores rich hidden model output under ACK-backpressured PTY output',
      suffix: '-rich-model',
      mode: 'rich-model'
    }
  ]
  for (const hiddenPressureCase of hiddenPressureCases) {
    test(hiddenPressureCase.title, async ({ orcaPage, testRepoPath }, testInfo) => {
      await runConfiguredHiddenRealPtyPressureScenario(
        orcaPage,
        testRepoPath,
        testInfo,
        HIDDEN_PRESSURE_PANES,
        hiddenPressureCase.suffix,
        hiddenPressureCase.mode
      )
    })
  }
})
