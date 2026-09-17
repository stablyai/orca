/**
 * Deterministic reproduction + benchmark for "typing lags while multiple
 * workspaces run agents" (the multi-workspace typing-latency complaint).
 *
 * Unlike the artificial-opencode suite (bounded bursts + held ACK gates),
 * this harness runs SUSTAINED paced agent-TUI streams through real PTYs in
 * background-workspace panes (and optionally visible splits) with no
 * artificial wedges, types at a fixed cadence WITHOUT waiting for each echo
 * (real users keep typing), and decomposes every key's latency into:
 *   input-half  = CDP keydown -> byte arrives at the pty (probe sidecar)
 *   echo-half   = pty echo    -> marker visible in the xterm buffer
 * All three clocks are epoch ms on one machine, so the halves add up.
 *
 * Scenarios are gated behind ORCA_TYPING_BENCH=1 (they are benchmarks that
 * may legitimately "fail" while the bug reproduces, not CI regression gates).
 * Set ORCA_TYPING_BENCH_INSTRUMENTATION=0 for a probe-off observer control.
 * Entry point: pnpm bench:multi-workspace-typing  (see
 * config/scripts/run-multi-workspace-typing-bench.mjs for knobs). Results are
 * written as JSON to tests/tools/benchmarks/results/ for A/B comparison.
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from './helpers/orca-app'
import { createTypingLoadWorkspaces, removeTypingLoadWorkspaces } from './typing-load-workspaces'
import { readTypingScaleCensus } from './typing-scale-census'
import { withTypingRendererCpuProfile } from './typing-renderer-cpu-profile'
import {
  measurePacedTyping,
  type LatencyStats,
  type PacedTypingMeasurement
} from './paced-terminal-typing'
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
  focusPane,
  waitForTerminalOutputForPtyId,
  type TerminalLoadPane
} from './artificial-opencode-pane-interactions'
import {
  sustainedLoadReadyFilePath,
  typingProbeReadyMarker,
  writeSustainedAgentLoadScript,
  writeTypingEchoProbeScript
} from './sustained-agent-typing-load-scripts'
import {
  cleanupAccumulatedWorkspaceFixture,
  seedAccumulatedWorkspaceFixture,
  startAccumulatedBenchmarkInstrumentation,
  stopAccumulatedBenchmarkInstrumentation
} from './accumulated-workspace-fixture'
import {
  startAccumulatedStatusTraffic,
  stopAccumulatedStatusTraffic,
  validateAccumulatedStatusIpcIngress,
  type AccumulatedStatusIngressValidation,
  type AccumulatedStatusTrafficStats
} from './accumulated-workspace-status-fixture'
import {
  startAccumulatedTitleTraffic,
  stopAccumulatedTitleTraffic
} from './accumulated-workspace-title-fixture'
import {
  injectRendererLongTaskSelfTest,
  startRuntimeGraphPublicationProbe,
  stopRuntimeGraphPublicationProbe,
  type RuntimeGraphPublicationProbeSnapshot
} from './runtime-graph-publication-probe'

const BENCH_ENABLED = process.env.ORCA_TYPING_BENCH === '1'

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const LOAD_WORKSPACES = readPositiveInt('ORCA_TYPING_BENCH_LOAD_WORKSPACES', 1)
const LOAD_PANES = readPositiveInt('ORCA_TYPING_BENCH_LOAD_PANES', 4)
const LOAD_RATE_KBPS = readPositiveInt('ORCA_TYPING_BENCH_RATE_KBPS', 256)
const KEY_COUNT = readPositiveInt('ORCA_TYPING_BENCH_KEYS', 32)
const KEY_CADENCE_MS = readPositiveInt('ORCA_TYPING_BENCH_KEY_CADENCE_MS', 250)
const CPU_WORKERS = readPositiveInt('ORCA_TYPING_BENCH_CPU_WORKERS', 0)
const PTY_METADATA = process.env.ORCA_TYPING_BENCH_PTY_METADATA === '1'
const BENCH_LABEL = process.env.ORCA_TYPING_BENCH_LABEL ?? 'dev'
// Request optional probes by default; the report records when the build does not install them.
const BENCH_INSTRUMENTATION_REQUESTED = process.env.ORCA_TYPING_BENCH_INSTRUMENTATION !== '0'
// Diagnostic only: patching main's invoke handler is observer overhead, so keep it out of acceptance runs.
const GRAPH_PROBE_REQUESTED = process.env.ORCA_TYPING_BENCH_GRAPH_PROBE === '1'
const GRAPH_PROBE_SELF_TEST_MS = readPositiveInt('ORCA_TYPING_BENCH_GRAPH_PROBE_SELFTEST_MS', 0)
// Estimates a slower single core. Applied only around the typing window: throttling setup would
// change what the fixture manages to build, not just how fast the measured window runs.
const CPU_THROTTLE_RATE = readPositiveInt('ORCA_TYPING_BENCH_CPU_THROTTLE', 1)

// Load must outlive setup (pane splits, worktree switches) plus the typing
// window; generously padded because setup time varies with pane count.
const LOAD_DURATION_S = Math.ceil((KEY_COUNT * KEY_CADENCE_MS) / 1000) + 90

const RESULTS_DIR = path.resolve(__dirname, '..', 'tools', 'benchmarks', 'results')

type SchedulerDebugSnapshot = {
  queuedChars: number
  peakQueuedChars: number
  droppedBacklogCount: number
}

type MainDeliveryDebugSnapshot = {
  pendingChars: number
  peakPendingChars: number
  peakRendererInFlightChars: number
  hiddenDeliveryGatedPtyCount: number
  hiddenDeliveryDroppedChars: number
  pendingDroppedChars: number
}

type TypingBenchWindow = Window & {
  __terminalOutputSchedulerDebug?: {
    reset: () => void
    snapshot: () => SchedulerDebugSnapshot
  }
}

async function readSchedulerDebug(page: Page): Promise<SchedulerDebugSnapshot | null> {
  return page.evaluate(
    () => (window as TypingBenchWindow).__terminalOutputSchedulerDebug?.snapshot() ?? null
  )
}

async function readMainDeliveryDebug(page: Page): Promise<MainDeliveryDebugSnapshot | null> {
  return page.evaluate(async () => window.api.pty.getRendererDeliveryDebugSnapshot())
}

async function resetDeliveryDebug(page: Page): Promise<void> {
  await page.evaluate(async () => {
    ;(window as TypingBenchWindow).__terminalOutputSchedulerDebug?.reset()
    await window.api.pty.resetRendererDeliveryDebug()
  })
}

function spawnCpuPressureWorkers(): ChildProcess[] {
  const workerPath = path.resolve(__dirname, '..', 'tools', 'benchmarks', 'cpu-pressure-worker.mjs')
  return Array.from({ length: CPU_WORKERS }, () =>
    spawn(process.execPath, [workerPath, String((LOAD_DURATION_S + 120) * 1000)], {
      stdio: 'ignore'
    })
  )
}

/** Rate 1 is a no-op, so an unthrottled run opens no CDP session at all. */
async function withRendererCpuThrottle<T>(
  page: Page,
  rate: number,
  run: () => Promise<T>
): Promise<T> {
  if (rate <= 1) {
    return await run()
  }
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Emulation.setCPUThrottlingRate', { rate })
    return await run()
  } finally {
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {})
    await session.detach().catch(() => {})
  }
}

function writeBenchReport(
  testInfo: TestInfo,
  scenario: string,
  measurement: PacedTypingMeasurement,
  scheduler: SchedulerDebugSnapshot | null,
  mainDelivery: MainDeliveryDebugSnapshot | null,
  instrumentation?: unknown,
  titleWorkload?: { registeredTabs: number; registeredPanes: number } | null,
  statusWorkload?: AccumulatedStatusTrafficStats | null,
  statusIngressValidation?: AccumulatedStatusIngressValidation | null,
  scaleCensus?: unknown,
  accumulatedFixture?: unknown,
  ptyWorkload?: unknown,
  graphProbe?: RuntimeGraphPublicationProbeSnapshot | null
): void {
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
      cpuWorkers: CPU_WORKERS,
      ptyMetadata: PTY_METADATA,
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
      cpuThrottleRate: CPU_THROTTLE_RATE,
      statusTrafficModel: PTY_METADATA
        ? 'pty-osc-through-runtime-and-ipc-bridge'
        : 'electron-ipc-burst-through-production-bridge'
    },
    measurement,
    scheduler,
    mainDelivery,
    instrumentation,
    titleWorkload: titleWorkload ?? null,
    statusWorkload: statusWorkload ?? null,
    statusIngressValidation: statusIngressValidation ?? null,
    scaleCensus: scaleCensus ?? null,
    accumulatedFixture: accumulatedFixture ?? null,
    ptyWorkload: ptyWorkload ?? null,
    graphProbe: graphProbe ?? null
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

async function startSustainedLoadInPanes(
  page: Page,
  panes: TerminalLoadPane[],
  scriptPath: string,
  runId: string,
  readyFileDirectory: string
): Promise<void> {
  for (const [index, pane] of panes.entries()) {
    await sendToTerminal(
      page,
      pane.ptyId,
      `node ${JSON.stringify(scriptPath)} ${index} ${LOAD_RATE_KBPS} ${LOAD_DURATION_S} ${PTY_METADATA ? 1 : 0} ${readPositiveInt('ORCA_TYPING_BENCH_TITLE_CHANGE_MS', 0)} ${readPositiveInt('ORCA_TYPING_BENCH_LIFECYCLE_MS', 0)}\r`
    )
  }
  // Readiness is signalled via files, not terminal markers: a streaming pane
  // scrolls its READY line out of the buffer before sequential checks get to
  // it once several panes start together.
  const missingReadyPanes = (): number[] =>
    panes
      .map((_, index) => index)
      .filter((index) => !existsSync(sustainedLoadReadyFilePath(readyFileDirectory, runId, index)))
  await expect
    .poll(() => missingReadyPanes().length, {
      timeout: 30_000,
      message: `load panes never signalled ready: ${missingReadyPanes().join(', ')}`
    })
    .toBe(0)
}

async function startTypingProbe(
  page: Page,
  typingPtyId: string,
  scriptPath: string,
  runId: string
): Promise<void> {
  await sendToTerminal(page, typingPtyId, `node ${JSON.stringify(scriptPath)}\r`)
  await waitForTerminalOutputForPtyId(page, typingPtyId, typingProbeReadyMarker(runId), 15_000)
}

function removeLoadReadyFiles(directory: string, runId: string, paneCount: number): void {
  for (let index = 0; index < paneCount; index++) {
    rmSync(sustainedLoadReadyFilePath(directory, runId, index), { force: true })
    rmSync(path.join(directory, `.orca-mwt-load-stats-${runId}-${index}`), { force: true })
  }
}

async function stopPtysQuietly(page: Page, ptyIds: string[]): Promise<void> {
  await Promise.all(
    ptyIds.map((ptyId) => sendToTerminal(page, ptyId, '\x03').catch(() => undefined))
  )
}

test.describe('Multi-workspace sustained typing latency bench', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(10 * 60 * 1000)
  // Group scope, not the test bodies: a body-level skip still builds the Electron fixtures.
  test.skip(!BENCH_ENABLED, 'Bench-only: run via pnpm bench:multi-workspace-typing')

  test('baseline: paced typing with no agent load', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const typingPtyId = await waitForActivePanePtyId(orcaPage)

    const runId = randomUUID()
    const probePath = path.join(testRepoPath, `.orca-mwt-probe-${runId}.mjs`)
    const sidecarPath = path.join(testRepoPath, `.orca-mwt-arrivals-${runId}.jsonl`)
    writeTypingEchoProbeScript(probePath, runId, sidecarPath)
    try {
      await resetDeliveryDebug(orcaPage)
      await startTypingProbe(orcaPage, typingPtyId, probePath, runId)
      const measurement = await withRendererCpuThrottle(orcaPage, CPU_THROTTLE_RATE, () =>
        withTypingRendererCpuProfile(orcaPage, process.env.ORCA_TYPING_BENCH_CPU_PROFILE, () =>
          measurePacedTyping(orcaPage, runId, sidecarPath, {
            keyCount: KEY_COUNT,
            keyCadenceMs: KEY_CADENCE_MS
          })
        )
      )
      writeBenchReport(
        testInfo,
        'baseline',
        measurement,
        await readSchedulerDebug(orcaPage),
        await readMainDeliveryDebug(orcaPage)
      )
      expect(measurement.inputHalfMs?.count).toBe(KEY_COUNT)
      expect(measurement.totalMs?.count).toBe(KEY_COUNT)
      expect(measurement.totalMs?.p50 ?? Number.POSITIVE_INFINITY).toBeLessThan(250)
    } finally {
      await stopPtysQuietly(orcaPage, [typingPtyId])
      rmSync(probePath, { force: true })
      rmSync(sidecarPath, { force: true })
    }
  })

  test('typing under sustained hidden multi-workspace agent load', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const typingWorktreeId = await waitForActiveWorktree(orcaPage)
    const loadWorktreeId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== typingWorktreeId)
    expect(Boolean(loadWorktreeId), 'bench needs the seeded secondary worktree').toBe(true)
    if (!loadWorktreeId) {
      return
    }

    const scratch = mkdtempSync(path.join(tmpdir(), 'orca-typing-load-'))
    const runId = randomUUID()
    const loadPath = path.join(scratch, `.orca-mwt-load-${runId}.mjs`)
    const probePath = path.join(scratch, `.orca-mwt-probe-${runId}.mjs`)
    const sidecarPath = path.join(scratch, `.orca-mwt-arrivals-${runId}.jsonl`)
    writeSustainedAgentLoadScript(loadPath, runId, scratch)
    writeTypingEchoProbeScript(probePath, runId, sidecarPath)

    const cpuWorkers = spawnCpuPressureWorkers()
    let loadPanes: TerminalLoadPane[] = []
    const createdWorktreeIds: string[] = []
    let titleWorkload: { registeredTabs: number; registeredPanes: number } | null = null
    let statusTrafficStarted = false
    let instrumentationAvailable = false
    let graphProbeStart: { main: string; renderer: string } | null = null
    let graphProbeSelfTestBeforeEpochMs = 0
    let statusIngressValidation: AccumulatedStatusIngressValidation | null = null
    try {
      await switchToWorktree(orcaPage, loadWorktreeId)
      loadPanes = await createTypingLoadWorkspaces(
        orcaPage,
        loadWorktreeId,
        LOAD_PANES,
        LOAD_WORKSPACES,
        readPositiveInt('ORCA_TYPING_BENCH_VISITED_WORKSPACES', LOAD_WORKSPACES),
        createdWorktreeIds
      )
      await startSustainedLoadInPanes(orcaPage, loadPanes, loadPath, runId, scratch)

      await switchToWorktree(orcaPage, typingWorktreeId)
      await expect
        .poll(() => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
        .toBe(typingWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      const typingPtyId = await waitForActivePanePtyId(orcaPage)

      const fixtureSummary = await seedAccumulatedWorkspaceFixture(orcaPage, {
        worktrees: readPositiveInt('ORCA_TYPING_BENCH_METADATA_WORKTREES', 870),
        repositories: readPositiveInt('ORCA_TYPING_BENCH_METADATA_REPOSITORIES', 27),
        terminalTabs: readPositiveInt('ORCA_TYPING_BENCH_METADATA_TERMINAL_TABS', 1410),
        unifiedTabs: readPositiveInt('ORCA_TYPING_BENCH_METADATA_UNIFIED_TABS', 2000),
        panesPerTab: readPositiveInt('ORCA_TYPING_BENCH_METADATA_PANES', 1),
        sleepingRecords: readPositiveInt('ORCA_TYPING_BENCH_METADATA_SLEEPERS', 857),
        liveStatuses: readPositiveInt('ORCA_TYPING_BENCH_METADATA_LIVE_STATUSES', 177),
        statusHistoryEntries: readPositiveInt('ORCA_TYPING_BENCH_METADATA_STATUS_HISTORY', 3)
      })
      if (process.env.ORCA_TYPING_BENCH_AGENT_ROWS === 'full') {
        await orcaPage.evaluate(() =>
          window.__store?.setState({
            worktreeCardProperties: ['status', 'inline-agents'],
            agentActivityDisplayMode: 'full'
          })
        )
      }
      console.log(`[multi-workspace-typing] accumulated fixture: ${JSON.stringify(fixtureSummary)}`)
      const statusTrafficEnabled =
        !PTY_METADATA && process.env.ORCA_TYPING_BENCH_METADATA_STATUS !== '0'
      if (statusTrafficEnabled) {
        statusIngressValidation = await validateAccumulatedStatusIpcIngress(electronApp, orcaPage)
        const validationPaneCount = Math.min(3, fixtureSummary.liveStatuses)
        expect(statusIngressValidation).toEqual({
          burstEvents: validationPaneCount,
          staggeredEvents: validationPaneCount
        })
      }
      if (BENCH_INSTRUMENTATION_REQUESTED) {
        instrumentationAvailable = await startAccumulatedBenchmarkInstrumentation(orcaPage)
      }
      if (GRAPH_PROBE_REQUESTED) {
        graphProbeStart = await startRuntimeGraphPublicationProbe(electronApp, orcaPage)
        if (GRAPH_PROBE_SELF_TEST_MS > 0) {
          await injectRendererLongTaskSelfTest(orcaPage, GRAPH_PROBE_SELF_TEST_MS)
          graphProbeSelfTestBeforeEpochMs = Date.now()
        }
        console.log(`[multi-workspace-typing] graph probe: ${JSON.stringify(graphProbeStart)}`)
      }
      if (statusTrafficEnabled) {
        const statusTraffic = await startAccumulatedStatusTraffic(
          electronApp,
          orcaPage,
          readPositiveInt('ORCA_TYPING_BENCH_METADATA_STATUS_INTERVAL_MS', 100)
        )
        expect(statusTraffic.trackedStatuses).toBe(fixtureSummary.liveStatuses)
        statusTrafficStarted = true
      }
      if (!PTY_METADATA && process.env.ORCA_TYPING_BENCH_METADATA_TITLES === '1') {
        titleWorkload = await startAccumulatedTitleTraffic(orcaPage, 100)
        console.log(
          `[multi-workspace-typing] registered title workload: ${JSON.stringify(titleWorkload)}`
        )
      }

      await resetDeliveryDebug(orcaPage)
      // Load is flowing when the hidden-delivery gate starts dropping the
      // background worktree's bytes — the topology the complaint describes.
      await expect
        .poll(
          async () => (await readMainDeliveryDebug(orcaPage))?.hiddenDeliveryDroppedChars ?? 0,
          { timeout: 30_000, message: 'hidden load never started flowing' }
        )
        .toBeGreaterThan(0)

      if (PTY_METADATA) {
        await expect
          .poll(
            () =>
              orcaPage.evaluate(
                () =>
                  Object.values(window.__store?.getState().agentStatusByPaneKey ?? {}).filter(
                    (row) => row.prompt === 'Synthetic production-path typing workload'
                  ).length
              ),
            { timeout: 30_000 }
          )
          .toBe(LOAD_PANES)
      }
      await startTypingProbe(orcaPage, typingPtyId, probePath, runId)
      const measurement = await withRendererCpuThrottle(orcaPage, CPU_THROTTLE_RATE, () =>
        withTypingRendererCpuProfile(orcaPage, process.env.ORCA_TYPING_BENCH_CPU_PROFILE, () =>
          measurePacedTyping(orcaPage, runId, sidecarPath, {
            keyCount: KEY_COUNT,
            keyCadenceMs: KEY_CADENCE_MS
          })
        )
      )
      const statusWorkload = statusTrafficStarted
        ? await stopAccumulatedStatusTraffic(electronApp, orcaPage)
        : null
      statusTrafficStarted = false
      if (statusWorkload) {
        // Presence first: the equalities below are all satisfied by an all-zero
        // result, so a controller that never started would read as success.
        expect(statusWorkload.generatedUpdates).toBeGreaterThan(0)
        expect(statusWorkload.trackedStatuses).toBeGreaterThan(0)
        expect(statusWorkload.acceptedUpdates).toBe(statusWorkload.generatedUpdates)
        expect(statusWorkload.latestReceipts).toBe(statusWorkload.trackedStatuses)
      }
      const instrumentation = BENCH_INSTRUMENTATION_REQUESTED
        ? await stopAccumulatedBenchmarkInstrumentation(orcaPage)
        : { available: false as const, reason: 'disabled' as const, snapshot: null }
      instrumentationAvailable = false
      const graphProbe = graphProbeStart
        ? await stopRuntimeGraphPublicationProbe(
            electronApp,
            orcaPage,
            graphProbeStart,
            graphProbeSelfTestBeforeEpochMs
          )
        : null
      graphProbeStart = null
      writeBenchReport(
        testInfo,
        `hidden-load-${LOAD_PANES}x${LOAD_RATE_KBPS}kbps-cpu${CPU_WORKERS}`,
        measurement,
        await readSchedulerDebug(orcaPage),
        await readMainDeliveryDebug(orcaPage),
        instrumentation,
        titleWorkload,
        statusWorkload,
        statusIngressValidation,
        await readTypingScaleCensus(orcaPage),
        fixtureSummary,
        {
          producers: loadPanes.map((_, index) =>
            JSON.parse(
              readFileSync(path.join(scratch, `.orca-mwt-load-stats-${runId}-${index}`), 'utf8')
            )
          ),
          receipts: await orcaPage.evaluate(() => {
            const state = window.__store?.getState()
            return {
              statuses: Object.values(state?.agentStatusByPaneKey ?? {})
                .filter((row) => row.prompt === 'Synthetic production-path typing workload')
                .map((row) => ({
                  sequence: row.acceptedStatusSeq,
                  providerSession: row.providerSession,
                  state: row.state,
                  message: row.lastAssistantMessage
                })),
              titles: Object.values(state?.runtimePaneTitlesByTabId ?? {}).flatMap(Object.values),
              agentRowsMode: state?.agentActivityDisplayMode,
              renderedAgentRows: document.querySelectorAll(
                '.worktree-agent-row-hover, .compact-agent-row'
              ).length
            }
          })
        },
        graphProbe
      )
      const screenDirectory = path.resolve('.tmp', 'typing-reproduction')
      mkdirSync(screenDirectory, { recursive: true })
      await orcaPage.screenshot({ path: path.join(screenDirectory, `${BENCH_LABEL}-screen.png`) })
      // Hang detector only — the JSON report is the benchmark output. A
      // reproduced regression shows up as large percentiles, not a hard fail.
      expect(measurement.inputHalfMs?.count).toBe(KEY_COUNT)
      expect(measurement.totalMs?.count).toBe(KEY_COUNT)

      await stopPtysQuietly(orcaPage, [typingPtyId])
    } finally {
      if (instrumentationAvailable) {
        await stopAccumulatedBenchmarkInstrumentation(orcaPage).catch(() => undefined)
      }
      if (statusTrafficStarted) {
        await stopAccumulatedStatusTraffic(electronApp, orcaPage)
      }
      await stopAccumulatedTitleTraffic(orcaPage)
      await cleanupAccumulatedWorkspaceFixture(orcaPage)
      for (const worker of cpuWorkers) {
        worker.kill('SIGKILL')
      }
      await switchToWorktree(orcaPage, loadWorktreeId).catch(() => undefined)
      await stopPtysQuietly(
        orcaPage,
        loadPanes.map((pane) => pane.ptyId)
      )
      await switchToWorktree(orcaPage, typingWorktreeId).catch(() => undefined)
      rmSync(loadPath, { force: true })
      rmSync(probePath, { force: true })
      rmSync(sidecarPath, { force: true })
      removeLoadReadyFiles(scratch, runId, LOAD_PANES)
      await removeTypingLoadWorkspaces(orcaPage, createdWorktreeIds)
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('typing under sustained visible split agent load', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const runId = randomUUID()
    const loadPath = path.join(testRepoPath, `.orca-mwt-load-${runId}.mjs`)
    const probePath = path.join(testRepoPath, `.orca-mwt-probe-${runId}.mjs`)
    const sidecarPath = path.join(testRepoPath, `.orca-mwt-arrivals-${runId}.jsonl`)
    writeSustainedAgentLoadScript(loadPath, runId, testRepoPath)
    writeTypingEchoProbeScript(probePath, runId, sidecarPath)

    const cpuWorkers = spawnCpuPressureWorkers()
    let panes: TerminalLoadPane[] = []
    try {
      // Pane 0 types; the rest replay the agent stream side by side — the
      // "Claude Code running in a visible split" shape.
      panes = await ensureActiveWorktreePaneLoad(orcaPage, 2)
      const [typingPane, ...loadPanes] = panes
      await startSustainedLoadInPanes(orcaPage, loadPanes, loadPath, runId, testRepoPath)
      await focusPane(orcaPage, typingPane.paneKey)

      await resetDeliveryDebug(orcaPage)
      await startTypingProbe(orcaPage, typingPane.ptyId, probePath, runId)
      const measurement = await withTypingRendererCpuProfile(
        orcaPage,
        process.env.ORCA_TYPING_BENCH_CPU_PROFILE,
        () =>
          measurePacedTyping(orcaPage, runId, sidecarPath, {
            keyCount: KEY_COUNT,
            keyCadenceMs: KEY_CADENCE_MS
          })
      )
      writeBenchReport(
        testInfo,
        `visible-split-${LOAD_RATE_KBPS}kbps-cpu${CPU_WORKERS}`,
        measurement,
        await readSchedulerDebug(orcaPage),
        await readMainDeliveryDebug(orcaPage)
      )
      expect(measurement.inputHalfMs?.count).toBe(KEY_COUNT)
      expect(measurement.totalMs?.count).toBe(KEY_COUNT)
    } finally {
      for (const worker of cpuWorkers) {
        worker.kill('SIGKILL')
      }
      await stopPtysQuietly(
        orcaPage,
        panes.map((pane) => pane.ptyId)
      )
      rmSync(loadPath, { force: true })
      rmSync(probePath, { force: true })
      rmSync(sidecarPath, { force: true })
      removeLoadReadyFiles(testRepoPath, runId, panes.length)
    }
  })
})
