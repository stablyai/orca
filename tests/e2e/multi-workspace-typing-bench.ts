// Shared knobs, delivery counters and report writer for the typing benches (see terminal-typing-benchmark.md).
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { withTypingRendererCpuProfile } from './typing-renderer-cpu-profile'
import {
  measurePacedTyping,
  type LatencyStats,
  type PacedTypingMeasurement
} from './paced-terminal-typing'
import { sendToTerminal } from './helpers/terminal'
import { waitForTerminalOutputForPtyId } from './artificial-opencode-pane-interactions'
import { typingProbeReadyMarker } from './sustained-agent-typing-load-scripts'
import type { SynchronizedOutputBlackoutSnapshot } from './synchronized-output-blackout-probe'
import type { GitChurnStats } from './git-churn-load'
import type {
  AccumulatedStatusIngressValidation,
  AccumulatedStatusTrafficStats
} from './accumulated-workspace-status-fixture'
import type { AccumulatedOrderTrafficStats } from './accumulated-workspace-order-fixture'
import { withInAppTypingDiagnostic } from './in-app-typing-diagnostic'
import type { RuntimeGraphPublicationProbeSnapshot } from './runtime-graph-publication-probe'

export const BENCH_ENABLED = process.env.ORCA_TYPING_BENCH === '1'

export function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export const LOAD_WORKSPACES = readPositiveInt('ORCA_TYPING_BENCH_LOAD_WORKSPACES', 1)
export const LOAD_PANES = readPositiveInt('ORCA_TYPING_BENCH_LOAD_PANES', 4)
export const LOAD_RATE_KBPS = readPositiveInt('ORCA_TYPING_BENCH_RATE_KBPS', 256)
export const KEY_COUNT = readPositiveInt('ORCA_TYPING_BENCH_KEYS', 32)
export const KEY_CADENCE_MS = readPositiveInt('ORCA_TYPING_BENCH_KEY_CADENCE_MS', 250)
export const CPU_WORKERS = readPositiveInt('ORCA_TYPING_BENCH_CPU_WORKERS', 0)
// Inject git churn because visibility-gated source-control pollers do not run in a hidden benchmark window.
export const GIT_CHURN_REPOS = readPositiveInt('ORCA_TYPING_BENCH_GIT_CHURN_REPOS', 0)
export const GIT_CHURN_FILES = readPositiveInt('ORCA_TYPING_BENCH_GIT_CHURN_FILES', 2000)
export const GIT_CHURN_CONCURRENCY = readPositiveInt('ORCA_TYPING_BENCH_GIT_CHURN_CONCURRENCY', 8)
// Configure Codex-shaped rows per key and source delay between frame body and closing DEC 2026 latch.
export const CODEX_FRAME_ROWS = readPositiveInt('ORCA_TYPING_BENCH_CODEX_FRAME_ROWS', 20)
export const CODEX_SPLIT_DELAY_MS =
  Number(process.env.ORCA_TYPING_BENCH_CODEX_SPLIT_DELAY_MS ?? 0) || 0
export const PTY_METADATA = process.env.ORCA_TYPING_BENCH_PTY_METADATA === '1'
export const BENCH_LABEL = process.env.ORCA_TYPING_BENCH_LABEL ?? 'dev'
// Request optional probes by default; the report records when the build does not install them.
export const BENCH_INSTRUMENTATION_REQUESTED = process.env.ORCA_TYPING_BENCH_INSTRUMENTATION !== '0'
// Diagnostic only: patching main's invoke handler is observer overhead, so keep it out of acceptance runs.
export const GRAPH_PROBE_REQUESTED = process.env.ORCA_TYPING_BENCH_GRAPH_PROBE === '1'
export const GRAPH_PROBE_SELF_TEST_MS = readPositiveInt(
  'ORCA_TYPING_BENCH_GRAPH_PROBE_SELFTEST_MS',
  0
)
// Throttle only typing: slowing setup changes fixture construction rather than the measured workload.
export const CPU_THROTTLE_RATE = readPositiveInt('ORCA_TYPING_BENCH_CPU_THROTTLE', 1)
// Rank-only order publications for seeded repos; 0 disables. Hidden-load scenario only.
export const ORDER_CHURN_MS = Number(process.env.ORCA_TYPING_BENCH_ORDER_CHURN_MS ?? 0) || 0
// The shipped renderer probe adds a write wrapper and long-animation-frame observer; keep it out of control runs.
export const IN_APP_DIAGNOSTIC = process.env.ORCA_TYPING_BENCH_IN_APP_DIAGNOSTIC === '1'

// Outlast setup plus typing; setup cost grows with pane count.
export const LOAD_DURATION_S = Math.ceil((KEY_COUNT * KEY_CADENCE_MS) / 1000) + 90

export const RESULTS_DIR = path.resolve(__dirname, '..', 'tools', 'benchmarks', 'results')

export type SchedulerDebugSnapshot = {
  queuedChars: number
  peakQueuedChars: number
  droppedBacklogCount: number
}

export type MainDeliveryDebugSnapshot = {
  pendingChars: number
  peakPendingChars: number
  peakRendererInFlightChars: number
  hiddenDeliveryGatedPtyCount: number
  hiddenDeliveryDroppedChars: number
  pendingDroppedChars: number
}

export type TypingBenchWindow = Window & {
  __terminalOutputSchedulerDebug?: {
    reset: () => void
    snapshot: () => SchedulerDebugSnapshot
  }
}

export async function readSchedulerDebug(page: Page): Promise<SchedulerDebugSnapshot | null> {
  return page.evaluate(
    () => (window as TypingBenchWindow).__terminalOutputSchedulerDebug?.snapshot() ?? null
  )
}

export async function readMainDeliveryDebug(page: Page): Promise<MainDeliveryDebugSnapshot | null> {
  return page.evaluate(async () => window.api.pty.getRendererDeliveryDebugSnapshot())
}

export async function resetDeliveryDebug(page: Page): Promise<void> {
  await page.evaluate(async () => {
    ;(window as TypingBenchWindow).__terminalOutputSchedulerDebug?.reset()
    await window.api.pty.resetRendererDeliveryDebug()
  })
}

export function spawnCpuPressureWorkers(): ChildProcess[] {
  const workerPath = path.resolve(__dirname, '..', 'tools', 'benchmarks', 'cpu-pressure-worker.mjs')
  return Array.from({ length: CPU_WORKERS }, () =>
    spawn(process.execPath, [workerPath, String((LOAD_DURATION_S + 120) * 1000)], {
      stdio: 'ignore'
    })
  )
}

/** Rate 1 is a no-op, so an unthrottled run opens no CDP session at all. */
export async function withRendererCpuThrottle<T>(
  page: Page,
  rate: number,
  run: () => Promise<T>
): Promise<{ result: T; appliedRate: number }> {
  if (rate <= 1) {
    return { result: await run(), appliedRate: 1 }
  }
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Emulation.setCPUThrottlingRate', { rate })
    return { result: await run(), appliedRate: rate }
  } finally {
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {})
    await session.detach().catch(() => {})
  }
}

/** Carries the conditions the window ran under, so the report cannot invent them. */
export type TypingWindowMeasurement = {
  measurement: PacedTypingMeasurement
  appliedCpuThrottleRate: number
  inAppDiagnostic: unknown
}

// Require actual scenario conditions before writeBenchReport can claim a throttle.
export async function measureTypingWindow(
  page: Page,
  runId: string,
  sidecarPath: string
): Promise<TypingWindowMeasurement> {
  const { result, appliedRate } = await withRendererCpuThrottle(page, CPU_THROTTLE_RATE, () =>
    withTypingRendererCpuProfile(page, process.env.ORCA_TYPING_BENCH_CPU_PROFILE, () =>
      withInAppTypingDiagnostic(page, IN_APP_DIAGNOSTIC, () =>
        measurePacedTyping(page, runId, sidecarPath, {
          keyCount: KEY_COUNT,
          keyCadenceMs: KEY_CADENCE_MS
        })
      )
    )
  )
  return {
    measurement: result.result,
    appliedCpuThrottleRate: appliedRate,
    inAppDiagnostic: result.report
  }
}

export type AppliedTypingWorkload = {
  cpuWorkers: number
  ptyMetadata: boolean
  statusTrafficModel:
    | 'pty-osc-through-runtime-and-ipc-bridge'
    | 'electron-ipc-burst-through-production-bridge'
    | null
}

export function writeBenchReport(
  testInfo: Pick<TestInfo, 'annotations'>,
  scenario: string,
  measured: TypingWindowMeasurement,
  workload: AppliedTypingWorkload,
  scheduler: SchedulerDebugSnapshot | null,
  mainDelivery: MainDeliveryDebugSnapshot | null,
  instrumentation?: unknown,
  titleWorkload?: { registeredTabs: number; registeredPanes: number } | null,
  statusWorkload?: AccumulatedStatusTrafficStats | null,
  statusIngressValidation?: AccumulatedStatusIngressValidation | null,
  scaleCensus?: unknown,
  accumulatedFixture?: unknown,
  ptyWorkload?: unknown,
  graphProbe?: RuntimeGraphPublicationProbeSnapshot | null,
  gitChurn?: GitChurnStats | null,
  blackout?: SynchronizedOutputBlackoutSnapshot | null,
  orderWorkload?: AccumulatedOrderTrafficStats | null
): void {
  const { measurement, appliedCpuThrottleRate, inAppDiagnostic } = measured
  const report = {
    benchmark: 'multi-workspace-typing-latency',
    label: BENCH_LABEL,
    scenario,
    timestamp: new Date().toISOString(),
    buildArtifacts: {
      mainSha256: createHash('sha256').update(readFileSync('out/main/index.js')).digest('hex'),
      rendererAssetNamesSha256: createHash('sha256')
        .update(readdirSync('out/renderer/assets').sort().join('\n'))
        .digest('hex')
    },
    config: {
      loadPanes: LOAD_PANES,
      loadWorkspaces: LOAD_WORKSPACES,
      visitedWorkspaces: readPositiveInt('ORCA_TYPING_BENCH_VISITED_WORKSPACES', LOAD_WORKSPACES),
      loadRateKbps: LOAD_RATE_KBPS,
      streamPacing: 'utf8-bytes-per-tick',
      keyCount: KEY_COUNT,
      keyCadenceMs: KEY_CADENCE_MS,
      cpuWorkers: workload.cpuWorkers,
      ptyMetadata: workload.ptyMetadata,
      cpuProfile: process.env.ORCA_TYPING_BENCH_CPU_PROFILE ?? null,
      titleChangeMs: readPositiveInt('ORCA_TYPING_BENCH_TITLE_CHANGE_MS', 0),
      lifecycleMs: readPositiveInt('ORCA_TYPING_BENCH_LIFECYCLE_MS', 0),
      agentRows: process.env.ORCA_TYPING_BENCH_AGENT_ROWS ?? 'default',
      metadataWorktrees: readPositiveInt('ORCA_TYPING_BENCH_METADATA_WORKTREES', 870),
      metadataRepositories: readPositiveInt('ORCA_TYPING_BENCH_METADATA_REPOSITORIES', 27),
      metadataTerminalTabs: readPositiveInt('ORCA_TYPING_BENCH_METADATA_TERMINAL_TABS', 1410),
      metadataUnifiedTabs: readPositiveInt('ORCA_TYPING_BENCH_METADATA_UNIFIED_TABS', 2000),
      metadataPanesPerTab: readPositiveInt('ORCA_TYPING_BENCH_METADATA_PANES', 1),
      metadataSleepingRecords: readPositiveInt('ORCA_TYPING_BENCH_METADATA_SLEEPERS', 857),
      metadataLiveStatuses: readPositiveInt('ORCA_TYPING_BENCH_METADATA_LIVE_STATUSES', 177),
      metadataStatusHistory: readPositiveInt('ORCA_TYPING_BENCH_METADATA_STATUS_HISTORY', 3),
      metadataStatusIntervalMs: readPositiveInt(
        'ORCA_TYPING_BENCH_METADATA_STATUS_INTERVAL_MS',
        100
      ),
      instrumentationRequested: BENCH_INSTRUMENTATION_REQUESTED,
      graphProbeRequested: GRAPH_PROBE_REQUESTED,
      orderChurnMs: ORDER_CHURN_MS,
      inAppDiagnostic: IN_APP_DIAGNOSTIC,
      // What this scenario actually ran under, not what the flag requested.
      cpuThrottleRate: appliedCpuThrottleRate,
      statusTrafficModel: workload.statusTrafficModel
    },
    measurement,
    inAppDiagnostic,
    scheduler,
    mainDelivery,
    instrumentation,
    titleWorkload: titleWorkload ?? null,
    statusWorkload: statusWorkload ?? null,
    statusIngressValidation: statusIngressValidation ?? null,
    scaleCensus: scaleCensus ?? null,
    accumulatedFixture: accumulatedFixture ?? null,
    ptyWorkload: ptyWorkload ?? null,
    graphProbe: graphProbe ?? null,
    gitChurn: gitChurn ?? null,
    synchronizedOutputBlackout: blackout ?? null,
    orderWorkload: orderWorkload ?? null
  }
  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = report.timestamp.replace(/[:.]/g, '-')
  const outPath = path.join(
    RESULTS_DIR,
    `multi-workspace-typing-${BENCH_LABEL}-${scenario}-${stamp}.json`
  )
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  const fmt = (stats: LatencyStats | null): string =>
    stats
      ? `p50 ${stats.p50.toFixed(1)}ms p90 ${stats.p90.toFixed(1)}ms max ${stats.max.toFixed(1)}ms`
      : 'n/a'
  testInfo.annotations.push({
    type: `multi-workspace-typing-${scenario}`,
    description:
      `planned-to-buffer ${fmt(measurement.plannedToBufferEchoMs)} | dispatch-delay ${fmt(measurement.dispatchDelayMs)} | ` +
      `total ${fmt(measurement.totalMs)} | input-half ${fmt(measurement.inputHalfMs)} | ` +
      `echo-half ${fmt(measurement.echoHalfMs)} | drift ${measurement.maxTimerDriftMs.toFixed(1)}ms | ` +
      `keys ${measurement.keyCount} validated | report ${outPath}`
  })
  console.log(`[multi-workspace-typing] ${scenario}: ${testInfo.annotations.at(-1)?.description}`)
}

export async function startTypingProbe(
  page: Page,
  typingPtyId: string,
  scriptPath: string,
  runId: string
): Promise<void> {
  await sendToTerminal(page, typingPtyId, `node ${JSON.stringify(scriptPath)}\r`)
  await waitForTerminalOutputForPtyId(page, typingPtyId, typingProbeReadyMarker(runId), 15_000)
}

export async function stopPtysQuietly(page: Page, ptyIds: string[]): Promise<void> {
  await Promise.all(
    ptyIds.map((ptyId) => sendToTerminal(page, ptyId, '\x03').catch(() => undefined))
  )
}
