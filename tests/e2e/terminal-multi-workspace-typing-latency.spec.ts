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
 * Entry point: pnpm bench:multi-workspace-typing  (see
 * config/scripts/run-multi-workspace-typing-bench.mjs for knobs). Results are
 * written as JSON to tests/tools/benchmarks/results/ for A/B comparison.
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
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

const BENCH_ENABLED = process.env.ORCA_TYPING_BENCH === '1'

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const LOAD_PANES = readPositiveInt('ORCA_TYPING_BENCH_LOAD_PANES', 4)
const LOAD_RATE_KBPS = readPositiveInt('ORCA_TYPING_BENCH_RATE_KBPS', 256)
const KEY_COUNT = readPositiveInt('ORCA_TYPING_BENCH_KEYS', 32)
const KEY_CADENCE_MS = readPositiveInt('ORCA_TYPING_BENCH_KEY_CADENCE_MS', 250)
const CPU_WORKERS = readPositiveInt('ORCA_TYPING_BENCH_CPU_WORKERS', 0)
const BENCH_LABEL = process.env.ORCA_TYPING_BENCH_LABEL ?? 'dev'

// Load must outlive setup (pane splits, worktree switches) plus the typing
// window; generously padded because setup time varies with pane count.
const LOAD_DURATION_S = Math.ceil((KEY_COUNT * KEY_CADENCE_MS) / 1000) + 90

const RESULTS_DIR = path.resolve(__dirname, '..', '..', 'tools', 'benchmarks', 'results')

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
  const workerPath = path.resolve(
    __dirname,
    '..',
    '..',
    'tools',
    'benchmarks',
    'cpu-pressure-worker.mjs'
  )
  return Array.from({ length: CPU_WORKERS }, () =>
    spawn(process.execPath, [workerPath, String((LOAD_DURATION_S + 120) * 1000)], {
      stdio: 'ignore'
    })
  )
}

function writeBenchReport(
  testInfo: TestInfo,
  scenario: string,
  measurement: PacedTypingMeasurement,
  scheduler: SchedulerDebugSnapshot | null,
  mainDelivery: MainDeliveryDebugSnapshot | null
): void {
  const report = {
    benchmark: 'multi-workspace-typing-latency',
    label: BENCH_LABEL,
    scenario,
    timestamp: new Date().toISOString(),
    config: {
      loadPanes: LOAD_PANES,
      loadRateKbps: LOAD_RATE_KBPS,
      keyCount: KEY_COUNT,
      keyCadenceMs: KEY_CADENCE_MS,
      cpuWorkers: CPU_WORKERS
    },
    measurement,
    scheduler,
    mainDelivery
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
      `total ${fmt(measurement.totalMs)} | input-half ${fmt(measurement.inputHalfMs)} | ` +
      `echo-half ${fmt(measurement.echoHalfMs)} | drift ${measurement.maxTimerDriftMs.toFixed(1)}ms | ` +
      `missingEcho ${measurement.missingEchoCount} | report ${outPath}`
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
      `node ${JSON.stringify(scriptPath)} ${index} ${LOAD_RATE_KBPS} ${LOAD_DURATION_S}\r`
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

  test('baseline: paced typing with no agent load', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.skip(!BENCH_ENABLED, 'Bench-only: run via pnpm bench:multi-workspace-typing')
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
      const measurement = await measurePacedTyping(orcaPage, runId, sidecarPath, {
        keyCount: KEY_COUNT,
        keyCadenceMs: KEY_CADENCE_MS
      })
      writeBenchReport(
        testInfo,
        'baseline',
        measurement,
        await readSchedulerDebug(orcaPage),
        await readMainDeliveryDebug(orcaPage)
      )
      expect(measurement.missingEchoCount).toBe(0)
      expect(measurement.totalMs?.p50 ?? Number.POSITIVE_INFINITY).toBeLessThan(250)
    } finally {
      await stopPtysQuietly(orcaPage, [typingPtyId])
      rmSync(probePath, { force: true })
      rmSync(sidecarPath, { force: true })
    }
  })

  test('typing under sustained hidden multi-workspace agent load', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.skip(!BENCH_ENABLED, 'Bench-only: run via pnpm bench:multi-workspace-typing')
    await waitForSessionReady(orcaPage)
    const typingWorktreeId = await waitForActiveWorktree(orcaPage)
    const loadWorktreeId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== typingWorktreeId)
    expect(Boolean(loadWorktreeId), 'bench needs the seeded secondary worktree').toBe(true)
    if (!loadWorktreeId) {
      return
    }

    const runId = randomUUID()
    const loadPath = path.join(testRepoPath, `.orca-mwt-load-${runId}.mjs`)
    const probePath = path.join(testRepoPath, `.orca-mwt-probe-${runId}.mjs`)
    const sidecarPath = path.join(testRepoPath, `.orca-mwt-arrivals-${runId}.jsonl`)
    writeSustainedAgentLoadScript(loadPath, runId, testRepoPath)
    writeTypingEchoProbeScript(probePath, runId, sidecarPath)

    const cpuWorkers = spawnCpuPressureWorkers()
    let loadPanes: TerminalLoadPane[] = []
    try {
      await switchToWorktree(orcaPage, loadWorktreeId)
      loadPanes = await ensureActiveWorktreePaneLoad(orcaPage, LOAD_PANES)
      await startSustainedLoadInPanes(orcaPage, loadPanes, loadPath, runId, testRepoPath)

      await switchToWorktree(orcaPage, typingWorktreeId)
      await expect
        .poll(() => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
        .toBe(typingWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      const typingPtyId = await waitForActivePanePtyId(orcaPage)

      await resetDeliveryDebug(orcaPage)
      // Load is flowing when the hidden-delivery gate starts dropping the
      // background worktree's bytes — the topology the complaint describes.
      await expect
        .poll(
          async () => (await readMainDeliveryDebug(orcaPage))?.hiddenDeliveryDroppedChars ?? 0,
          { timeout: 30_000, message: 'hidden load never started flowing' }
        )
        .toBeGreaterThan(0)

      await startTypingProbe(orcaPage, typingPtyId, probePath, runId)
      const measurement = await measurePacedTyping(orcaPage, runId, sidecarPath, {
        keyCount: KEY_COUNT,
        keyCadenceMs: KEY_CADENCE_MS
      })
      writeBenchReport(
        testInfo,
        `hidden-load-${LOAD_PANES}x${LOAD_RATE_KBPS}kbps-cpu${CPU_WORKERS}`,
        measurement,
        await readSchedulerDebug(orcaPage),
        await readMainDeliveryDebug(orcaPage)
      )
      // Hang detector only — the JSON report is the benchmark output. A
      // reproduced regression shows up as large percentiles, not a hard fail.
      expect(measurement.missingEchoCount).toBe(0)

      await stopPtysQuietly(orcaPage, [typingPtyId])
    } finally {
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
      removeLoadReadyFiles(testRepoPath, runId, LOAD_PANES)
    }
  })

  test('typing under sustained visible split agent load', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.skip(!BENCH_ENABLED, 'Bench-only: run via pnpm bench:multi-workspace-typing')
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
      const measurement = await measurePacedTyping(orcaPage, runId, sidecarPath, {
        keyCount: KEY_COUNT,
        keyCadenceMs: KEY_CADENCE_MS
      })
      writeBenchReport(
        testInfo,
        `visible-split-${LOAD_RATE_KBPS}kbps-cpu${CPU_WORKERS}`,
        measurement,
        await readSchedulerDebug(orcaPage),
        await readMainDeliveryDebug(orcaPage)
      )
      expect(measurement.missingEchoCount).toBe(0)
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
