import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { sendToTerminal } from './helpers/terminal'
import { writePressureOutputScript } from './artificial-opencode-hidden-pressure-script'
import {
  annotateScrollMeasurement,
  getResponsiveScrollPath,
  measureActiveTerminalWheelScroll,
  scrollActiveTerminalToBottom,
  seedActiveTerminalScrollback
} from './artificial-opencode-scroll-scenario'

type MainPressurePane = {
  paneKey: string
  ptyId: string
}

type MainPressureMeasurement = {
  medianLatencyMs: number
  worstLatencyMs: number
  maxTimerDriftMs: number
}

type MainPressureSnapshot = {
  peakPendingChars: number
  peakRendererInFlightChars: number
  ackGatedFlushSkipCount: number
}

type MainPressureAckGate = {
  heldAckChars: number
}

type MainPressureSchedulerSnapshot = {
  peakQueuedChars: number
  droppedBacklogCount: number
}

// Why: peak queued chars is noisy at the byte level on CI, but a coarse cap
// still catches renderer queue growth that dropped-backlog/latency checks miss.
const MAX_RENDERER_SCHEDULER_QUEUED_CHARS = 5 * 1024 * 1024
const MAIN_RENDERER_PRESSURE_TARGET_CHARS = 2 * 1024 * 1024

type MainPressureDeps<
  TMeasurement,
  TDebug,
  TScheduler extends MainPressureSchedulerSnapshot,
  TMainPressure,
  TAckGate
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
  ensureActiveWorktreePaneLoad: (page: Page, paneCount: number) => Promise<MainPressurePane[]>
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
  waitForActiveWorktree: (page: Page) => Promise<string>
  waitForMainPtyPressureBacklog: (page: Page) => Promise<TMainPressure>
  waitForSessionReady: (page: Page) => Promise<void>
  writeInteractivePromptScript: (scriptPath: string, runId: string) => void
}

export async function runMainPressureScenario<
  TMeasurement extends MainPressureMeasurement,
  TMainPressure extends MainPressureSnapshot,
  TAckGate extends MainPressureAckGate,
  TDebug,
  TScheduler extends MainPressureSchedulerSnapshot
>({
  annotationSuffix,
  backgroundPaneCount,
  deps,
  maxMedianKeyLatencyMs,
  maxScrollLatencyMs,
  maxTimerDriftMs,
  maxWorstKeyLatencyMs,
  pressureOutputChars,
  testInfo,
  testRepoPath,
  mcodePage
}: {
  annotationSuffix: string
  backgroundPaneCount: number
  deps: MainPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  maxMedianKeyLatencyMs: number
  maxScrollLatencyMs: number
  maxTimerDriftMs: number
  maxWorstKeyLatencyMs: number
  pressureOutputChars: number
  testInfo: TestInfo
  testRepoPath: string
  mcodePage: Page
}): Promise<void> {
  await deps.waitForSessionReady(mcodePage)
  await deps.waitForActiveWorktree(mcodePage)
  const panes = await deps.ensureActiveWorktreePaneLoad(mcodePage, backgroundPaneCount + 1)
  const [typingPane, ...loadPanes] = panes
  await deps.focusPane(mcodePage, typingPane.paneKey)

  const runId = randomUUID()
  const scrollRunId = randomUUID()
  const typingScriptPath = path.join(testRepoPath, `.mcode-opencode-pressure-typing-${runId}.mjs`)
  const pressureScriptPath = path.join(testRepoPath, `.mcode-opencode-pressure-load-${runId}.mjs`)
  await seedActiveTerminalScrollback(mcodePage, typingPane.ptyId, scrollRunId)
  deps.writeInteractivePromptScript(typingScriptPath, runId)
  writePressureOutputScript(pressureScriptPath, runId, 'tui')
  await deps.resetTerminalPtyOutputDebug(mcodePage)
  await deps.holdTerminalAckGate(
    mcodePage,
    loadPanes.map((pane) => pane.ptyId)
  )
  try {
    await startPressureCommands({
      loadPanes,
      mcodePage,
      pressureOutputChars,
      pressureScriptPath
    })
    const pressureBeforeTyping = await deps.waitForMainPtyPressureBacklog(mcodePage)
    await measureAndAnnotateScroll({
      annotationSuffix,
      deps,
      maxScrollLatencyMs,
      maxTimerDriftMs,
      mcodePage,
      panes,
      testInfo
    })
    const measurement = await deps.measureTypingDuringLoad(
      mcodePage,
      typingScriptPath,
      typingPane.ptyId,
      runId
    )
    const mainPressure = await deps.readMainPtyPressureDebug(mcodePage)
    const ackGate = await deps.readTerminalAckGateDebug(mcodePage)
    const scheduler = await deps.readTerminalOutputSchedulerDebug(mcodePage)
    deps.annotateTypingMeasurement(
      testInfo,
      `opencode-main-pressure-active-typing${annotationSuffix}`,
      panes.length,
      measurement,
      await deps.readTerminalPtyOutputDebug(mcodePage),
      scheduler,
      mainPressure,
      ackGate
    )
    expectMainPressureAndTyping({
      ackGate,
      mainPressure,
      maxMedianKeyLatencyMs,
      maxTimerDriftMs,
      maxWorstKeyLatencyMs,
      measurement,
      pressureBeforeTyping,
      scheduler
    })
  } finally {
    await deps.releaseTerminalAckGate(mcodePage)
    await sendToTerminal(mcodePage, typingPane.ptyId, '\x03').catch(() => undefined)
    await Promise.all(
      loadPanes.map((pane) => sendToTerminal(mcodePage, pane.ptyId, '\x03').catch(() => undefined))
    )
    rmSync(typingScriptPath, { force: true })
    rmSync(pressureScriptPath, { force: true })
  }
}

async function startPressureCommands({
  loadPanes,
  mcodePage,
  pressureOutputChars,
  pressureScriptPath
}: {
  loadPanes: MainPressurePane[]
  mcodePage: Page
  pressureOutputChars: number
  pressureScriptPath: string
}): Promise<void> {
  await Promise.all(
    loadPanes.map((pane, paneIndex) =>
      sendToTerminal(
        mcodePage,
        pane.ptyId,
        `node ${JSON.stringify(pressureScriptPath)} ${paneIndex} ${pressureOutputChars}\r`
      )
    )
  )
}

async function measureAndAnnotateScroll<
  TMeasurement,
  TDebug,
  TScheduler extends MainPressureSchedulerSnapshot,
  TMainPressure,
  TAckGate
>({
  annotationSuffix,
  deps,
  maxScrollLatencyMs,
  maxTimerDriftMs,
  mcodePage,
  panes,
  testInfo
}: {
  annotationSuffix: string
  deps: MainPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  maxScrollLatencyMs: number
  maxTimerDriftMs: number
  mcodePage: Page
  panes: MainPressurePane[]
  testInfo: TestInfo
}): Promise<void> {
  const scrollMeasurement = await measureActiveTerminalWheelScroll(mcodePage)
  const mainPressureAfterScroll = await deps.readMainPtyPressureDebug(mcodePage)
  const ackGateAfterScroll = await deps.readTerminalAckGateDebug(mcodePage)
  annotateScrollMeasurement(
    testInfo,
    `opencode-main-pressure-active-scroll${annotationSuffix}`,
    panes.length,
    scrollMeasurement,
    mainPressureAfterScroll,
    ackGateAfterScroll
  )
  const responsivePath = getResponsiveScrollPath(scrollMeasurement)
  if (responsivePath) {
    expect(responsivePath.latencyMs).toBeLessThan(maxScrollLatencyMs)
  }
  expect(scrollMeasurement.maxTimerDriftMs).toBeLessThan(maxTimerDriftMs)
  await scrollActiveTerminalToBottom(mcodePage)
}

function expectMainPressureAndTyping<TMeasurement extends MainPressureMeasurement>({
  ackGate,
  mainPressure,
  maxMedianKeyLatencyMs,
  maxTimerDriftMs,
  maxWorstKeyLatencyMs,
  measurement,
  pressureBeforeTyping,
  scheduler
}: {
  ackGate: MainPressureAckGate | null
  mainPressure: MainPressureSnapshot | null
  maxMedianKeyLatencyMs: number
  maxTimerDriftMs: number
  maxWorstKeyLatencyMs: number
  measurement: TMeasurement
  pressureBeforeTyping: MainPressureSnapshot
  scheduler: MainPressureSchedulerSnapshot | null
}): void {
  expect(pressureBeforeTyping.peakPendingChars).toBeGreaterThan(0)
  expect(pressureBeforeTyping.ackGatedFlushSkipCount).toBeGreaterThan(0)
  expect(mainPressure?.peakRendererInFlightChars ?? 0).toBeGreaterThanOrEqual(
    MAIN_RENDERER_PRESSURE_TARGET_CHARS
  )
  expect(ackGate?.heldAckChars ?? 0).toBeGreaterThan(0)
  expect(scheduler?.droppedBacklogCount ?? Number.POSITIVE_INFINITY).toBe(0)
  expect(scheduler?.peakQueuedChars ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    MAX_RENDERER_SCHEDULER_QUEUED_CHARS
  )
  expect(measurement.medianLatencyMs).toBeLessThan(maxMedianKeyLatencyMs)
  expect(measurement.worstLatencyMs).toBeLessThan(maxWorstKeyLatencyMs)
  expect(measurement.maxTimerDriftMs).toBeLessThan(maxTimerDriftMs)
}
