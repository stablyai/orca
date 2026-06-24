import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { sendToTerminal } from './helpers/terminal'
import { writePtyInputAccepted } from './helpers/terminal-accepted-input'
import { writePressureOutputScript } from './artificial-opencode-pressure-output-script'
import {
  annotateScrollMeasurement,
  getResponsiveScrollPath,
  measureActiveTerminalWheelScroll,
  scrollActiveTerminalToBottom,
  seedActiveTerminalScrollback
} from './artificial-opencode-scroll-scenario'
import { waitForMainPressureSourcePauseRelease } from './artificial-opencode-main-pressure-release'
import {
  expectMainPressureAndTyping,
  waitForMainPressureTypingReadiness
} from './artificial-opencode-main-pressure-budget'

type MainPressurePane = {
  paneKey: string
  ptyId: string
}

export type MainPressureMeasurement = {
  medianLatencyMs: number
  worstLatencyMs: number
  maxTimerDriftMs: number
}

export type MainPressureSnapshot = {
  flushScheduled?: boolean
  pendingChars?: number
  peakPendingChars: number
  peakRendererInFlightChars: number
  rendererInFlightChars?: number
  ackGatedFlushSkipCount: number
  sourcePausedPtyCount?: number
}

export type MainPressureAckGate = {
  heldAckChars: number
}

export type MainPressureSchedulerSnapshot = {
  peakQueuedChars: number
  droppedBacklogCount: number
}

const MAIN_PRESSURE_OUTPUT_CHARS_PER_PANE = 48 * 1024

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
    runId: string,
    inputMethod?: 'keyboard' | 'ptyWrite' | 'terminalInput'
  ) => Promise<TMeasurement>
  measureReadyPromptTyping: (
    page: Page,
    ptyId: string,
    runId: string,
    inputMethod?: 'keyboard' | 'ptyWrite' | 'terminalInput',
    maxWorstKeyLatencyMs?: number
  ) => Promise<TMeasurement>
  prepareTypingPrompt: (
    page: Page,
    scriptPath: string,
    ptyId: string,
    runId: string
  ) => Promise<void>
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
  orcaPage
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
  orcaPage: Page
}): Promise<void> {
  await deps.waitForSessionReady(orcaPage)
  await deps.waitForActiveWorktree(orcaPage)
  const [initialTypingPane] = await deps.ensureActiveWorktreePaneLoad(orcaPage, 1)
  if (!initialTypingPane) {
    throw new Error('Active typing pane was not created')
  }
  await deps.focusPane(orcaPage, initialTypingPane.paneKey)

  const runId = randomUUID()
  const scrollRunId = randomUUID()
  const typingScriptPath = path.join(testRepoPath, `.orca-opencode-pressure-typing-${runId}.mjs`)
  const pressureScriptPath = path.join(testRepoPath, `.orca-opencode-pressure-load-${runId}.mjs`)
  deps.writeInteractivePromptScript(typingScriptPath, runId)
  writePressureOutputScript(pressureScriptPath, runId)
  const panes = await deps.ensureActiveWorktreePaneLoad(orcaPage, backgroundPaneCount + 1)
  const typingPane =
    panes.find((pane) => pane.ptyId === initialTypingPane.ptyId) ?? initialTypingPane
  const loadPanes = panes.filter((pane) => pane.ptyId !== typingPane.ptyId)
  await deps.focusPane(orcaPage, typingPane.paneKey)
  await deps.resetTerminalPtyOutputDebug(orcaPage)
  await deps.holdTerminalAckGate(
    orcaPage,
    loadPanes.map((pane) => pane.ptyId)
  )
  try {
    await startPressureCommands({
      loadPanes,
      orcaPage,
      pressureOutputChars,
      pressureScriptPath
    })
    const pressureBeforeTyping = await deps.waitForMainPtyPressureBacklog(orcaPage)
    await deps.focusPane(orcaPage, typingPane.paneKey)
    await seedActiveTerminalScrollback(orcaPage, typingPane.ptyId, scrollRunId)
    await measureAndAnnotateScroll({
      annotationSuffix,
      deps,
      maxScrollLatencyMs,
      maxTimerDriftMs,
      orcaPage,
      panes,
      ptyId: typingPane.ptyId,
      testInfo
    })
    await deps.prepareTypingPrompt(orcaPage, typingScriptPath, typingPane.ptyId, runId)
    await waitForMainPressureTypingReadiness({
      backgroundPaneCount: loadPanes.length,
      readMainPtyPressureDebug: deps.readMainPtyPressureDebug,
      orcaPage
    })
    const measurement = await deps.measureReadyPromptTyping(
      orcaPage,
      typingPane.ptyId,
      runId,
      'terminalInput',
      maxWorstKeyLatencyMs
    )
    const mainPressure = await deps.readMainPtyPressureDebug(orcaPage)
    const ackGate = await deps.readTerminalAckGateDebug(orcaPage)
    const scheduler = await deps.readTerminalOutputSchedulerDebug(orcaPage)
    deps.annotateTypingMeasurement(
      testInfo,
      `opencode-main-pressure-active-typing${annotationSuffix}`,
      panes.length,
      measurement,
      await deps.readTerminalPtyOutputDebug(orcaPage),
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
    await deps.releaseTerminalAckGate(orcaPage)
    await orcaPage.evaluate((ptyId) => {
      window.api.pty.setActiveRendererPty?.(ptyId, false)
    }, typingPane.ptyId)
    await waitForMainPressureSourcePauseRelease(orcaPage, deps.readMainPtyPressureDebug)
    await sendToTerminal(orcaPage, typingPane.ptyId, '\x03').catch(() => undefined)
    await Promise.all(
      loadPanes.map((pane) => sendToTerminal(orcaPage, pane.ptyId, '\x03').catch(() => undefined))
    )
    rmSync(typingScriptPath, { force: true })
    rmSync(pressureScriptPath, { force: true })
  }
}

async function startPressureCommands({
  loadPanes,
  orcaPage,
  pressureOutputChars,
  pressureScriptPath
}: {
  loadPanes: MainPressurePane[]
  orcaPage: Page
  pressureOutputChars: number
  pressureScriptPath: string
}): Promise<void> {
  await Promise.all(
    loadPanes.map((pane, paneIndex) =>
      writePtyInputAccepted(
        orcaPage,
        pane.ptyId,
        `\x03\x15${[
          `node ${JSON.stringify(`./${path.basename(pressureScriptPath)}`)}`,
          paneIndex,
          Math.min(pressureOutputChars, MAIN_PRESSURE_OUTPUT_CHARS_PER_PANE),
          0,
          'idle'
        ].join(' ')}\r`
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
  orcaPage,
  panes,
  ptyId,
  testInfo
}: {
  annotationSuffix: string
  deps: MainPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  maxScrollLatencyMs: number
  maxTimerDriftMs: number
  orcaPage: Page
  panes: MainPressurePane[]
  ptyId: string
  testInfo: TestInfo
}): Promise<void> {
  const scrollMeasurement = await measureActiveTerminalWheelScroll(orcaPage, ptyId)
  const mainPressureAfterScroll = await deps.readMainPtyPressureDebug(orcaPage)
  const ackGateAfterScroll = await deps.readTerminalAckGateDebug(orcaPage)
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
  await scrollActiveTerminalToBottom(orcaPage, ptyId)
}
