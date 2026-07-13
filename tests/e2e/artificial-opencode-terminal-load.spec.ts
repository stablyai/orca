import type { Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  ensureActiveWorktreePaneLoad,
  focusActiveTerminalInput,
  focusPane,
  waitForMarkerLatency,
  waitForTerminalOutputForPtyId
} from './artificial-opencode-pane-interactions'
import { runHiddenRealPtyPressureScenario } from './artificial-opencode-hidden-pressure-scenario'
import type { HiddenPressureOutputMode } from './artificial-opencode-hidden-pressure-script'
import { runMainPressureScenario } from './artificial-opencode-main-pressure-scenario'
import { runRendererBackpressureRevisitScenario } from './artificial-opencode-revisit-pressure-scenario'
import { startSyntheticOpenCodeInjection } from './artificial-opencode-synthetic-injection'

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

// Why: the renderer hidden-skip grammar is deleted — hidden bytes are dropped
// in main (gate) or ride the background queue. Only the mode-2031 fact-reply
// counter still has a renderer-side producer.
type TerminalPtyOutputDebugSnapshot = {
  hiddenRendererMode2031ReplyCount: number
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
const DEFAULT_SAME_WORKSPACE_PANES = 5
const DEFAULT_CROSS_WORKSPACE_PANES_PER_WORKTREE = 3
const DEFAULT_PRESSURE_BACKGROUND_PANES = 17
const DEFAULT_PRESSURE_OUTPUT_CHARS = 768 * 1024
const DEFAULT_HIDDEN_PRESSURE_PANES = 17
const HIDDEN_PRESSURE_START_DELAY_MS = 1200
const DEFAULT_FRAME_COUNT = 180
const DEFAULT_FRAME_INTERVAL_MS = 6
const TIMER_SAMPLE_MS = 16
const MAIN_RENDERER_PRESSURE_TARGET_CHARS = 2 * 1024 * 1024
// Why: these are regression budgets, not observed baselines. Repeated local
// 100-pane OpenCode-scale runs are below 50ms worst-key latency; keep enough
// CI headroom while still failing changes that make typing visibly sluggish.
const MAX_MEDIAN_KEY_LATENCY_MS = 75
const MAX_WORST_KEY_LATENCY_MS = 300
// Why: under injected multi-pane load, the worst *single* key echo lands behind
// whichever synthetic flush it collides with, so on a CPU-starved OSS shard it
// is environment-dominated (seen at ~3.1s) even when typing stays instant. The
// median (75ms) is the real responsiveness guard; keep worst-under-load only as
// a catastrophic-hang detector. Mirrors ssh-docker-relay-perf's 2s worst-key
// tolerance and the hidden-pressure scenario's relaxed worst budget.
const MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS = 3_000
// Why: the post-revisit printf is sampled while the background panes are still
// ACK-gate-held and through a whole-buffer serialize poll, so it inherits the
// same environment-dominated worst-case as typing under load; the unloaded
// 300ms budget has no margin for this switch-and-focus moment.
const MAX_REVISIT_LATENCY_UNDER_LOAD_MS = 3_000
// Why: GitHub's two-worker Electron shards can briefly starve renderer timers
// without visible typing lag. Keep this as a smoke gate, not a CPU lottery.
const MAX_TIMER_DRIFT_MS = 250
// Why: under injected multi-pane redraw load the renderer event loop is
// environment-dominated (seen at ~1s on a CPU-starved OSS shard) even when
// typing stays responsive, mirroring MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS. Keep
// this only as a catastrophic-starvation gate; the unloaded 250ms budget guards
// the real baseline.
const MAX_TIMER_DRIFT_UNDER_LOAD_MS = 2_500
const MAX_SCROLL_LATENCY_MS = 150
const MAX_RENDERER_SCHEDULER_QUEUED_CHARS = 3 * 1024 * 1024

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
  // Why: long scale runs can outlive temporary repo cleanup races in the test
  // harness; the prompt script only needs a writable directory, not git state.
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
    const start = performance.now()
    await page.keyboard.type(char)
    // Why: wait up to the under-load budget so a slow echo is measured and
    // asserted per-scenario, not thrown as a confusing "did not contain".
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
  const mode2031Summary = debug ? ` mode2031Replies=${debug.hiddenRendererMode2031ReplyCount}` : ''
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
      .join(',')}${mode2031Summary}${schedulerSummary}${mainPressureSummary}${ackGateSummary}`
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
    const measurement = await measureTypingDuringLoad(orcaPage, scriptPath, typingPtyId, runId)
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
    expect(scheduler?.rendererDroppedBacklogs ?? 0).toBe(0)
    expect(measurement.medianLatencyMs).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
    expect(measurement.worstLatencyMs).toBeLessThan(MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS)
    expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_TIMER_DRIFT_UNDER_LOAD_MS)
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
    maxMedianKeyLatencyMs: MAX_MEDIAN_KEY_LATENCY_MS,
    maxScrollLatencyMs: MAX_SCROLL_LATENCY_MS,
    maxTimerDriftMs: MAX_TIMER_DRIFT_MS,
    maxWorstKeyLatencyMs: MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS,
    deps: terminalLoadScenarioDeps
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
      const measurement = await measureTypingDuringLoad(orcaPage, scriptPath, typingPtyId, runId)
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
      expect(measurement.medianLatencyMs).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
      expect(measurement.worstLatencyMs).toBeLessThan(MAX_WORST_KEY_LATENCY_MS)
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
    const panes = await ensureActiveWorktreePaneLoad(orcaPage, SAME_WORKSPACE_PANES)
    const [typingPane, ...loadPanes] = panes
    await focusPane(orcaPage, typingPane.paneKey)

    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-opencode-typing-${runId}.mjs`)
    writeInteractivePromptScript(scriptPath, runId)
    await resetTerminalPtyOutputDebug(orcaPage)
    const load = await startSyntheticOpenCodeInjection({
      frameCount: FRAME_COUNT,
      intervalMs: FRAME_INTERVAL_MS,
      page: orcaPage,
      paneKeys: loadPanes.map((pane) => pane.paneKey)
    })
    try {
      const measurement = await measureTypingDuringLoad(
        orcaPage,
        scriptPath,
        typingPane.ptyId,
        runId
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
      expect(measurement.medianLatencyMs).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
      expect(measurement.worstLatencyMs).toBeLessThan(MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS)
      expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_TIMER_DRIFT_UNDER_LOAD_MS)
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
      // Why: the printf is sampled while background panes are ACK-gate-held, so
      // worst-key and timer drift are environment-dominated here (worst seen ~2s)
      // like the other under-load scenarios; keep the strict budgets for the
      // unloaded baseline test only.
      maxTimerDriftMs: MAX_TIMER_DRIFT_UNDER_LOAD_MS,
      maxWorstKeyLatencyMs: MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS,
      orcaPage,
      pressureOutputChars: PRESSURE_OUTPUT_CHARS,
      testInfo,
      testRepoPath
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
      const panes = await ensureActiveWorktreePaneLoad(orcaPage, paneCount)
      const [typingPane, ...loadPanes] = panes
      await focusPane(orcaPage, typingPane.paneKey)

      const runId = randomUUID()
      const scriptPath = path.join(testRepoPath, `.orca-opencode-scale-${paneCount}-${runId}.mjs`)
      writeInteractivePromptScript(scriptPath, runId)
      await resetTerminalPtyOutputDebug(orcaPage)
      const load = await startSyntheticOpenCodeInjection({
        frameCount: FRAME_COUNT,
        intervalMs: FRAME_INTERVAL_MS,
        page: orcaPage,
        paneKeys: loadPanes.map((pane) => pane.paneKey)
      })
      try {
        const measurement = await measureTypingDuringLoad(
          orcaPage,
          scriptPath,
          typingPane.ptyId,
          runId
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
        expect(measurement.medianLatencyMs).toBeLessThan(MAX_MEDIAN_KEY_LATENCY_MS)
        expect(measurement.worstLatencyMs).toBeLessThan(MAX_WORST_KEY_LATENCY_UNDER_LOAD_MS)
        expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_TIMER_DRIFT_UNDER_LOAD_MS)
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
      // Why: the 10s codex startup renderer-query window is deleted — every
      // pressure mode measures steady-state model restore with one delay.
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
    // Why: "withholds renderer delivery" — hidden bytes are dropped in main by
    // the delivery gate; the renderer no longer skip-scans chunks (Phase 6).
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
