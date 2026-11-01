// Benchmark sustained paced real-PTY agent load while typing at fixed cadence without waiting for echoes.
// Split latency into CDP keydown→PTY receipt and receipt→xterm-buffer detection on one machine’s epoch clock; neither proves pixel paint.
// ORCA_TYPING_BENCH=1 gates benchmarks, not CI regressions; ORCA_TYPING_BENCH_INSTRUMENTATION=0 supplies a probe-off observer control.
// Run pnpm bench:multi-workspace-typing (runner documents knobs); JSON results go to tests/tools/benchmarks/results/.
import type { Page } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from './helpers/orca-app'
import { createTypingLoadWorkspaces, removeTypingLoadWorkspaces } from './typing-load-workspaces'
import { readTypingScaleCensus } from './typing-scale-census'
import {
  ensureTerminalVisible,
  getActiveTabId,
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
  type TerminalLoadPane
} from './artificial-opencode-pane-interactions'
import {
  sustainedLoadReadyFilePath,
  writeCodexEchoProbeScript,
  writeSustainedAgentLoadScript,
  writeTypingEchoProbeScript
} from './sustained-agent-typing-load-scripts'
import {
  startSynchronizedOutputBlackoutProbe,
  stopSynchronizedOutputBlackoutProbe,
  type SynchronizedOutputBlackoutSnapshot
} from './synchronized-output-blackout-probe'
import {
  createGitChurnRepos,
  registerGitChurnRepos,
  startGitChurnLoad,
  stopGitChurnLoad,
  type GitChurnStats
} from './git-churn-load'
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
  type AccumulatedStatusIngressValidation
} from './accumulated-workspace-status-fixture'
import {
  startAccumulatedTitleTraffic,
  stopAccumulatedTitleTraffic
} from './accumulated-workspace-title-fixture'
import {
  startAccumulatedOrderTraffic,
  stopAccumulatedOrderTraffic
} from './accumulated-workspace-order-fixture'
import {
  injectRendererLongTaskSelfTest,
  startRuntimeGraphPublicationProbe,
  stopRuntimeGraphPublicationProbe,
  type RendererLongTaskSelfTestWindow
} from './runtime-graph-publication-probe'
import {
  BENCH_ENABLED,
  readPositiveInt,
  LOAD_WORKSPACES,
  LOAD_PANES,
  LOAD_RATE_KBPS,
  KEY_COUNT,
  CPU_WORKERS,
  GIT_CHURN_REPOS,
  GIT_CHURN_FILES,
  GIT_CHURN_CONCURRENCY,
  CODEX_FRAME_ROWS,
  CODEX_SPLIT_DELAY_MS,
  PTY_METADATA,
  BENCH_LABEL,
  BENCH_INSTRUMENTATION_REQUESTED,
  GRAPH_PROBE_REQUESTED,
  GRAPH_PROBE_SELF_TEST_MS,
  ORDER_CHURN_MS,
  LOAD_DURATION_S,
  readSchedulerDebug,
  readMainDeliveryDebug,
  resetDeliveryDebug,
  spawnCpuPressureWorkers,
  measureTypingWindow,
  writeBenchReport,
  startTypingProbe,
  stopPtysQuietly
} from './multi-workspace-typing-bench'

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
  // Signal readiness through files: concurrent streaming panes can scroll READY out before sequential buffer checks.
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

function removeLoadReadyFiles(directory: string, runId: string, paneCount: number): void {
  for (let index = 0; index < paneCount; index++) {
    rmSync(sustainedLoadReadyFilePath(directory, runId, index), { force: true })
    rmSync(path.join(directory, `.orca-mwt-load-stats-${runId}-${index}`), { force: true })
  }
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
      const measured = await measureTypingWindow(orcaPage, runId, sidecarPath)
      const { measurement } = measured
      writeBenchReport(
        testInfo,
        'baseline',
        measured,
        { cpuWorkers: 0, ptyMetadata: false, statusTrafficModel: null },
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
    let orderTrafficStarted = false
    let instrumentationAvailable = false
    let graphProbeStart: { main: string; renderer: string } | null = null
    let graphProbeSelfTest: RendererLongTaskSelfTestWindow | null = null
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
          graphProbeSelfTest = await injectRendererLongTaskSelfTest(
            orcaPage,
            GRAPH_PROBE_SELF_TEST_MS
          )
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

      if (ORDER_CHURN_MS > 0) {
        const orderedRepos = await startAccumulatedOrderTraffic(orcaPage, ORDER_CHURN_MS)
        expect(orderedRepos).toBe(fixtureSummary.repositories)
        orderTrafficStarted = true
      }

      await resetDeliveryDebug(orcaPage)
      // Hidden-byte drops prove load flows through the background-worktree delivery gate.
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
      const measured = await measureTypingWindow(orcaPage, runId, sidecarPath)
      const { measurement } = measured
      const orderWorkload = orderTrafficStarted ? await stopAccumulatedOrderTraffic(orcaPage) : null
      orderTrafficStarted = false
      if (orderWorkload) {
        expect(orderWorkload.publications).toBeGreaterThan(0)
      }
      const statusWorkload = statusTrafficStarted
        ? await stopAccumulatedStatusTraffic(electronApp, orcaPage)
        : null
      statusTrafficStarted = false
      if (statusWorkload) {
        // Require controller presence before equalities that an all-zero result would satisfy.
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
            graphProbeSelfTest
          )
        : null
      graphProbeStart = null
      writeBenchReport(
        testInfo,
        `hidden-load-${LOAD_PANES}x${LOAD_RATE_KBPS}kbps-cpu${CPU_WORKERS}${ORDER_CHURN_MS > 0 ? `-order${ORDER_CHURN_MS}ms` : ''}`,
        measured,
        {
          cpuWorkers: cpuWorkers.length,
          ptyMetadata: PTY_METADATA,
          statusTrafficModel: PTY_METADATA
            ? 'pty-osc-through-runtime-and-ipc-bridge'
            : statusWorkload
              ? 'electron-ipc-burst-through-production-bridge'
              : null
        },
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
        graphProbe,
        null,
        null,
        orderWorkload
      )
      const screenDirectory = path.resolve('.tmp', 'typing-reproduction')
      mkdirSync(screenDirectory, { recursive: true })
      await orcaPage.screenshot({ path: path.join(screenDirectory, `${BENCH_LABEL}-screen.png`) })
      // Timeout catches hangs only; report regressions through JSON percentiles.
      expect(measurement.inputHalfMs?.count).toBe(KEY_COUNT)
      expect(measurement.totalMs?.count).toBe(KEY_COUNT)

      await stopPtysQuietly(orcaPage, [typingPtyId])
    } finally {
      if (orderTrafficStarted) {
        await stopAccumulatedOrderTraffic(orcaPage).catch(() => null)
      }
      if (instrumentationAvailable) {
        await stopAccumulatedBenchmarkInstrumentation(orcaPage).catch(() => undefined)
      }
      if (graphProbeStart) {
        await stopRuntimeGraphPublicationProbe(
          electronApp,
          orcaPage,
          graphProbeStart,
          graphProbeSelfTest
        ).catch(() => undefined)
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
      // Type in pane 0 while adjacent panes stream, matching a visible agent split.
      panes = await ensureActiveWorktreePaneLoad(orcaPage, 2)
      const [typingPane, ...loadPanes] = panes
      await startSustainedLoadInPanes(orcaPage, loadPanes, loadPath, runId, testRepoPath)
      await focusPane(orcaPage, typingPane.paneKey)

      await resetDeliveryDebug(orcaPage)
      await startTypingProbe(orcaPage, typingPane.ptyId, probePath, runId)
      const measured = await measureTypingWindow(orcaPage, runId, sidecarPath)
      const { measurement } = measured
      writeBenchReport(
        testInfo,
        `visible-split-${LOAD_RATE_KBPS}kbps-cpu${CPU_WORKERS}`,
        measured,
        {
          cpuWorkers: cpuWorkers.length,
          ptyMetadata: PTY_METADATA,
          statusTrafficModel: PTY_METADATA ? 'pty-osc-through-runtime-and-ipc-bridge' : null
        },
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

  // Require --git-churn-repos: main’s git subprocess polling competes with PTY relay on the same event loop.
  // Without it this would duplicate the visible-split scenario.
  test('typing under sustained git-subprocess churn', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.skip(
      GIT_CHURN_REPOS === 0,
      'Set --git-churn-repos to run: this scenario measures git-spawn churn, not PTY bytes'
    )
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const runId = randomUUID()
    const loadPath = path.join(testRepoPath, `.orca-mwt-load-${runId}.mjs`)
    const probePath = path.join(testRepoPath, `.orca-mwt-probe-${runId}.mjs`)
    const sidecarPath = path.join(testRepoPath, `.orca-mwt-arrivals-${runId}.jsonl`)
    const churnRoot = mkdtempSync(path.join(tmpdir(), 'orca-git-churn-'))
    writeSustainedAgentLoadScript(loadPath, runId, testRepoPath)
    writeTypingEchoProbeScript(probePath, runId, sidecarPath)

    const cpuWorkers = spawnCpuPressureWorkers()
    let panes: TerminalLoadPane[] = []
    let gitChurn: GitChurnStats | null = null
    try {
      const repos = createGitChurnRepos(churnRoot, GIT_CHURN_REPOS, GIT_CHURN_FILES)
      const registration = await registerGitChurnRepos(
        orcaPage,
        repos.map((repo) => repo.path)
      )
      expect(
        registration,
        `churn repos were not registered with Orca: ${registration.failures.join('; ')}`
      ).toMatchObject({ registered: repos.length })
      panes = await ensureActiveWorktreePaneLoad(orcaPage, 2)
      const [typingPane, ...loadPanes] = panes
      await startSustainedLoadInPanes(orcaPage, loadPanes, loadPath, runId, testRepoPath)
      await focusPane(orcaPage, typingPane.paneKey)

      await resetDeliveryDebug(orcaPage)
      await startTypingProbe(orcaPage, typingPane.ptyId, probePath, runId)
      await startGitChurnLoad(
        orcaPage,
        repos.map((repo) => repo.path),
        { concurrency: GIT_CHURN_CONCURRENCY, admissionTier: 'status' }
      )
      const measured = await measureTypingWindow(orcaPage, runId, sidecarPath)
      gitChurn = await stopGitChurnLoad(orcaPage)
      const { measurement } = measured
      writeBenchReport(
        testInfo,
        `git-churn-${GIT_CHURN_REPOS}repos-x${GIT_CHURN_CONCURRENCY}`,
        measured,
        {
          cpuWorkers: cpuWorkers.length,
          ptyMetadata: PTY_METADATA,
          statusTrafficModel: PTY_METADATA ? 'pty-osc-through-runtime-and-ipc-bridge' : null
        },
        await readSchedulerDebug(orcaPage),
        await readMainDeliveryDebug(orcaPage),
        undefined,
        null,
        null,
        null,
        undefined,
        undefined,
        undefined,
        null,
        gitChurn
      )
      // Require spawned git children; rejection-only loops cannot measure subprocess churn.
      expect(gitChurn?.settled ?? 0).toBeGreaterThan(0)
      expect(
        gitChurn,
        `git churn never reached git: ${gitChurn?.firstError ?? 'unknown error'}`
      ).toMatchObject({ failed: 0 })
      expect(measurement.inputHalfMs?.count).toBe(KEY_COUNT)
      expect(measurement.totalMs?.count).toBe(KEY_COUNT)
    } finally {
      await stopGitChurnLoad(orcaPage).catch(() => null)
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
      rmSync(churnRoot, { recursive: true, force: true })
      removeLoadReadyFiles(testRepoPath, runId, panes.length)
    }
  })

  // Measure render gaps for synchronized-output foreground repaint under background load.
  // A delayed closing ?2026l can suppress rows until xterm’s 1000ms force-flush while buffer-only observations report fast echo.
  test('typing a DEC 2026 foreground TUI under agent load, measured at the render', async ({
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
    writeCodexEchoProbeScript(probePath, runId, sidecarPath, {
      frameRows: CODEX_FRAME_ROWS,
      splitDelayMs: CODEX_SPLIT_DELAY_MS
    })

    const cpuWorkers = spawnCpuPressureWorkers()
    let panes: TerminalLoadPane[] = []
    let blackout: SynchronizedOutputBlackoutSnapshot | null = null
    try {
      panes = await ensureActiveWorktreePaneLoad(orcaPage, Math.max(2, LOAD_PANES + 1))
      const [typingPane, ...loadPanes] = panes
      await startSustainedLoadInPanes(orcaPage, loadPanes, loadPath, runId, testRepoPath)
      await focusPane(orcaPage, typingPane.paneKey)

      await resetDeliveryDebug(orcaPage)
      await startTypingProbe(orcaPage, typingPane.ptyId, probePath, runId)
      const activeTabId = await getActiveTabId(orcaPage)
      const probeInstall = await startSynchronizedOutputBlackoutProbe(orcaPage, activeTabId ?? '')
      // Require probe installation so missing instrumentation cannot report a false zero-blackout success.
      expect(probeInstall, `blackout probe not installed: ${probeInstall.reason}`).toMatchObject({
        installed: true
      })

      const measured = await measureTypingWindow(orcaPage, runId, sidecarPath)
      blackout = await stopSynchronizedOutputBlackoutProbe(orcaPage)
      const { measurement } = measured
      writeBenchReport(
        testInfo,
        `dec2026-render-${LOAD_PANES}panes-${LOAD_RATE_KBPS}kbps-rows${CODEX_FRAME_ROWS}`,
        measured,
        {
          cpuWorkers: cpuWorkers.length,
          ptyMetadata: PTY_METADATA,
          statusTrafficModel: PTY_METADATA ? 'pty-osc-through-runtime-and-ipc-bridge' : null
        },
        await readSchedulerDebug(orcaPage),
        await readMainDeliveryDebug(orcaPage),
        undefined,
        null,
        null,
        null,
        await readTypingScaleCensus(orcaPage).catch(() => null),
        undefined,
        undefined,
        null,
        null,
        blackout
      )
      expect(measurement.totalMs?.count).toBe(KEY_COUNT)
      expect(blackout?.renderCount ?? 0).toBeGreaterThan(0)
    } finally {
      await stopSynchronizedOutputBlackoutProbe(orcaPage).catch(() => null)
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
