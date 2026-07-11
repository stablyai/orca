import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { writePressureOutputScript } from './artificial-opencode-hidden-pressure-script'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

type RevisitPressurePane = { paneKey: string; ptyId: string }

type RevisitPressureMeasurement = {
  medianLatencyMs: number
  worstLatencyMs: number
  maxTimerDriftMs: number
}

// Why: the renderer hidden-skip counters were deleted with the skip grammar;
// only the mode-2031 fact-reply counter still exists renderer-side.
type RevisitPressureDebug = { hiddenRendererMode2031ReplyCount: number }

type RevisitPressureSchedulerSnapshot = {
  peakQueuedChars: number
  droppedBacklogCount: number
}

type RevisitPressureMainSnapshot = {
  peakPendingChars: number
  peakRendererInFlightChars: number
  ackGatedFlushSkipCount: number
}

type RevisitPressureAckGate = { heldAckChars: number }

type RevisitPressureDeps<
  TMeasurement extends RevisitPressureMeasurement,
  TDebug extends RevisitPressureDebug,
  TScheduler extends RevisitPressureSchedulerSnapshot,
  TMainPressure extends RevisitPressureMainSnapshot,
  TAckGate extends RevisitPressureAckGate
> = {
  annotateTypingMeasurement: (
    testInfo: TestInfo,
    type: string,
    paneCount: number,
    measurement: TMeasurement,
    debug: TDebug | null,
    scheduler: TScheduler | null,
    mainPressure: TMainPressure | null,
    ackGate: TAckGate | null
  ) => void
  ensureActiveWorktreePaneLoad: (page: Page, paneCount: number) => Promise<RevisitPressurePane[]>
  focusPane: (page: Page, paneKey: string) => Promise<void>
  holdTerminalAckGate: (page: Page, ptyIds: string[]) => Promise<void>
  measureTypingDuringLoad: (
    page: Page,
    scriptPath: string,
    ptyId: string,
    runId: string
  ) => Promise<TMeasurement>
  readMainPtyPressureDebug: (page: Page) => Promise<TMainPressure | null>
  readTerminalAckGateDebug: (page: Page) => Promise<TAckGate | null>
  readTerminalOutputSchedulerDebug: (page: Page) => Promise<TScheduler | null>
  readTerminalPtyOutputDebug: (page: Page) => Promise<TDebug | null>
  releaseTerminalAckGate: (page: Page) => Promise<void>
  resetTerminalPtyOutputDebug: (page: Page) => Promise<void>
  waitForMainPtyPressureBacklog: (page: Page) => Promise<TMainPressure>
  writeInteractivePromptScript: (scriptPath: string, runId: string) => void
}

export async function runRendererBackpressureRevisitScenario<
  TMeasurement extends RevisitPressureMeasurement,
  TDebug extends RevisitPressureDebug,
  TScheduler extends RevisitPressureSchedulerSnapshot,
  TMainPressure extends RevisitPressureMainSnapshot,
  TAckGate extends RevisitPressureAckGate
>({
  backgroundPaneCount,
  deps,
  maxMedianKeyLatencyMs,
  maxRendererSchedulerQueuedChars,
  maxTimerDriftMs,
  maxWorstKeyLatencyMs,
  mainRendererPressureTargetChars,
  pressureOutputChars,
  orcaPage,
  testInfo,
  testRepoPath
}: {
  backgroundPaneCount: number
  deps: RevisitPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  maxMedianKeyLatencyMs: number
  maxRendererSchedulerQueuedChars: number
  maxTimerDriftMs: number
  maxWorstKeyLatencyMs: number
  mainRendererPressureTargetChars: number
  pressureOutputChars: number
  orcaPage: Page
  testInfo: TestInfo
  testRepoPath: string
}): Promise<void> {
  await waitForSessionReady(orcaPage)
  const firstWorktreeId = await waitForActiveWorktree(orcaPage)
  const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== firstWorktreeId)
  expect(Boolean(secondWorktreeId), 'renderer backpressure revisit needs a second worktree').toBe(
    true
  )
  if (!secondWorktreeId) {
    return
  }

  const runId = randomUUID()
  const typingPtyReadyMarker = `OPENCODE_REVISIT_TYPING_PTY_READY_${runId}`
  await switchToWorktree(orcaPage, secondWorktreeId)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const typingPtyId = await waitForActivePanePtyId(orcaPage)
  await sendToTerminal(orcaPage, typingPtyId, `printf '\\n${typingPtyReadyMarker}\\n'\r`)
  await waitForMarkerLatency(orcaPage, typingPtyReadyMarker, 10_000)

  await switchToWorktree(orcaPage, firstWorktreeId)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const panes = await deps.ensureActiveWorktreePaneLoad(orcaPage, backgroundPaneCount + 1)
  const [revisitPane, ...loadPanes] = panes
  await deps.focusPane(orcaPage, revisitPane.paneKey)

  const typingScriptPath = path.join(testRepoPath, `.orca-revisit-typing-${runId}.mjs`)
  const pressureScriptPath = path.join(testRepoPath, `.orca-revisit-pressure-${runId}.mjs`)
  const revisitMarker = `OPENCODE_REVISIT_READY_${runId}`
  const pressureDoneMarker = `OPENCODE_PRESSURE_DONE_${runId}_0`
  deps.writeInteractivePromptScript(typingScriptPath, runId)
  writePressureOutputScript(pressureScriptPath, runId, 'tui')
  await deps.resetTerminalPtyOutputDebug(orcaPage)
  await deps.holdTerminalAckGate(
    orcaPage,
    loadPanes.map((pane) => pane.ptyId)
  )
  try {
    await startRealPtyPressureCommands({
      loadPanes,
      orcaPage,
      pressureOutputChars,
      pressureScriptPath
    })
    const pressureBeforeSwitch = await deps.waitForMainPtyPressureBacklog(orcaPage)

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const measurement = await deps.measureTypingDuringLoad(
      orcaPage,
      typingScriptPath,
      typingPtyId,
      runId
    )
    const duringPressure = await deps.readMainPtyPressureDebug(orcaPage)
    const ackGate = await deps.readTerminalAckGateDebug(orcaPage)
    const scheduler = await deps.readTerminalOutputSchedulerDebug(orcaPage)
    const hiddenDebug = await deps.readTerminalPtyOutputDebug(orcaPage)
    deps.annotateTypingMeasurement(
      testInfo,
      'opencode-main-pressure-worktree-revisit-typing',
      panes.length + 1,
      measurement,
      hiddenDebug,
      scheduler,
      duringPressure,
      ackGate
    )

    expectPressureStayedBounded({
      ackGate,
      mainRendererPressureTargetChars,
      maxMedianKeyLatencyMs,
      maxRendererSchedulerQueuedChars,
      maxTimerDriftMs,
      maxWorstKeyLatencyMs,
      measurement,
      pressureBeforeSwitch,
      scheduler,
      duringPressure
    })

    await switchToWorktree(orcaPage, firstWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await deps.focusPane(orcaPage, revisitPane.paneKey)
    await sendToTerminal(orcaPage, revisitPane.ptyId, `printf '\\n${revisitMarker}\\n'\r`)
    const revisitLatencyMs = await waitForMarkerLatency(orcaPage, revisitMarker, 10_000)
    testInfo.annotations.push({
      type: 'opencode-main-pressure-worktree-revisit-marker',
      description: `panes=${panes.length + 1} revisit=${revisitLatencyMs.toFixed(
        1
      )}ms heldAckChars=${ackGate?.heldAckChars ?? 0}`
    })
    expect(revisitLatencyMs).toBeLessThan(maxWorstKeyLatencyMs)

    await deps.releaseTerminalAckGate(orcaPage)
    await deps.focusPane(orcaPage, loadPanes[0]?.paneKey ?? revisitPane.paneKey)
    const pressureDrainLatencyMs = await waitForMarkerLatency(orcaPage, pressureDoneMarker, 20_000)
    const finalScheduler = await deps.readTerminalOutputSchedulerDebug(orcaPage)
    testInfo.annotations.push({
      type: 'opencode-main-pressure-worktree-revisit-drain',
      description: `panes=${panes.length + 1} drain=${pressureDrainLatencyMs.toFixed(
        1
      )}ms rendererPeakQueuedChars=${finalScheduler?.peakQueuedChars ?? 0} rendererDroppedBacklogs=${
        finalScheduler?.droppedBacklogCount ?? 0
      }`
    })
    expect(finalScheduler?.droppedBacklogCount ?? Number.POSITIVE_INFINITY).toBe(0)
    expect(finalScheduler?.peakQueuedChars ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      maxRendererSchedulerQueuedChars
    )
  } finally {
    await deps.releaseTerminalAckGate(orcaPage)
    await sendToTerminal(orcaPage, typingPtyId, '\x03').catch(() => undefined)
    await sendToTerminal(orcaPage, revisitPane.ptyId, '\x03').catch(() => undefined)
    await Promise.all(
      loadPanes.map((pane) => sendToTerminal(orcaPage, pane.ptyId, '\x03').catch(() => undefined))
    )
    rmSync(typingScriptPath, { force: true })
    rmSync(pressureScriptPath, { force: true })
  }
}

async function startRealPtyPressureCommands({
  loadPanes,
  orcaPage,
  pressureOutputChars,
  pressureScriptPath
}: {
  loadPanes: RevisitPressurePane[]
  orcaPage: Page
  pressureOutputChars: number
  pressureScriptPath: string
}): Promise<void> {
  await Promise.all(
    loadPanes.map((pane, paneIndex) =>
      sendToTerminal(
        orcaPage,
        pane.ptyId,
        `node ${JSON.stringify(pressureScriptPath)} ${paneIndex} ${pressureOutputChars}\r`
      )
    )
  )
}

async function waitForMarkerLatency(
  page: Page,
  marker: string,
  timeoutMs: number
): Promise<number> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if ((await getTerminalContent(page, 12_000)).includes(marker)) {
      return performance.now() - start
    }
    await page.waitForTimeout(5)
  }
  throw new Error(`Timed out waiting for terminal marker ${marker}`)
}

function expectPressureStayedBounded<TMeasurement extends RevisitPressureMeasurement>({
  ackGate,
  mainRendererPressureTargetChars,
  maxMedianKeyLatencyMs,
  maxRendererSchedulerQueuedChars,
  maxTimerDriftMs,
  maxWorstKeyLatencyMs,
  measurement,
  pressureBeforeSwitch,
  scheduler,
  duringPressure
}: {
  ackGate: RevisitPressureAckGate | null
  mainRendererPressureTargetChars: number
  maxMedianKeyLatencyMs: number
  maxRendererSchedulerQueuedChars: number
  maxTimerDriftMs: number
  maxWorstKeyLatencyMs: number
  measurement: TMeasurement
  pressureBeforeSwitch: RevisitPressureMainSnapshot
  scheduler: RevisitPressureSchedulerSnapshot | null
  duringPressure: RevisitPressureMainSnapshot | null
}): void {
  expect(pressureBeforeSwitch.peakPendingChars).toBeGreaterThan(0)
  expect(pressureBeforeSwitch.ackGatedFlushSkipCount).toBeGreaterThan(0)
  expect(duringPressure?.peakRendererInFlightChars ?? 0).toBeGreaterThanOrEqual(
    mainRendererPressureTargetChars
  )
  expect(ackGate?.heldAckChars ?? 0).toBeGreaterThan(0)
  expect(scheduler?.droppedBacklogCount ?? Number.POSITIVE_INFINITY).toBe(0)
  expect(scheduler?.peakQueuedChars ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    maxRendererSchedulerQueuedChars
  )
  expect(measurement.medianLatencyMs).toBeLessThan(maxMedianKeyLatencyMs)
  expect(measurement.worstLatencyMs).toBeLessThan(maxWorstKeyLatencyMs)
  expect(measurement.maxTimerDriftMs).toBeLessThan(maxTimerDriftMs)
}
