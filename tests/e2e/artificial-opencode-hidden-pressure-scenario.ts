import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
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
  focusTerminalPaneForPtyId,
  getTerminalContentForPtyId
} from './helpers/terminal-pty-content'
import { writePressureOutputScript } from './artificial-opencode-pressure-output-script'
import {
  startHiddenPressureCommands,
  type HiddenPressurePane
} from './artificial-opencode-hidden-pressure-commands'

type HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate> = {
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
  ensureActiveWorktreePaneLoad: (page: Page, paneCount: number) => Promise<HiddenPressurePane[]>
  holdTerminalAckGate: (page: Page, ptyIds: string[]) => Promise<void>
  measureTypingDuringLoad: (
    page: Page,
    scriptPath: string,
    ptyId: string,
    runId: string,
    inputMethod?: 'keyboard' | 'ptyWrite',
    maxWorstKeyLatencyMs?: number
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

type HiddenPressureDebug = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
}

type HiddenPressureMeasurement = {
  medianLatencyMs: number
  worstLatencyMs: number
  maxTimerDriftMs: number
}

type HiddenPressureMainSnapshot = {
  peakPendingChars: number
  peakRendererInFlightChars: number
  ackGatedFlushSkipCount: number
  sourcePausedPtyCount?: number
}

type HiddenPressureAckGate = {
  heldAckChars: number
}

// Why: source-paused hidden PTYs may need to resume and finish producing their
// retained tail before the DONE marker exists; keep a hard gate below the old
// pathological 10s+ restores while allowing the lossless backpressure path.
const MAX_HIDDEN_RESTORE_LATENCY_MS = 8_000

export async function runHiddenRealPtyPressureScenario<
  TMeasurement extends HiddenPressureMeasurement,
  TDebug extends HiddenPressureDebug,
  TMainPressure extends HiddenPressureMainSnapshot,
  TAckGate extends HiddenPressureAckGate,
  TScheduler
>({
  deps,
  annotationSuffix,
  hiddenPaneCount,
  pressureOutputChars,
  pressureStartDelayMs,
  maxWorstKeyLatencyMs,
  testInfo,
  testRepoPath,
  orcaPage
}: {
  deps: HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  annotationSuffix?: string
  hiddenPaneCount: number
  pressureOutputChars: number
  pressureStartDelayMs: number
  maxWorstKeyLatencyMs: number
  testInfo: TestInfo
  testRepoPath: string
  orcaPage: Page
}): Promise<void> {
  await waitForSessionReady(orcaPage)
  const firstWorktreeId = await waitForActiveWorktree(orcaPage)
  const allWorktreeIds = await getAllWorktreeIds(orcaPage)
  const secondWorktreeId = allWorktreeIds.find((id) => id !== firstWorktreeId)
  expect(Boolean(secondWorktreeId), 'OpenCode hidden PTY pressure needs a second worktree').toBe(
    true
  )
  if (!secondWorktreeId) {
    return
  }

  await switchToWorktree(orcaPage, secondWorktreeId)
  const hiddenPanes = await deps.ensureActiveWorktreePaneLoad(orcaPage, hiddenPaneCount)

  const runId = randomUUID()
  const typingScriptPath = path.join(
    testRepoPath,
    `.orca-opencode-hidden-pressure-typing-${runId}.mjs`
  )
  const pressureScriptPath = path.join(
    testRepoPath,
    `.orca-opencode-hidden-pressure-load-${runId}.mjs`
  )
  deps.writeInteractivePromptScript(typingScriptPath, runId)
  writePressureOutputScript(pressureScriptPath, runId)

  await deps.resetTerminalPtyOutputDebug(orcaPage)
  await deps.holdTerminalAckGate(
    orcaPage,
    hiddenPanes.map((pane) => pane.ptyId)
  )
  try {
    await startHiddenPressureCommands({
      hiddenPanes,
      orcaPage,
      pressureOutputChars,
      pressureScriptPath,
      pressureStartDelayMs
    })
    await switchToTypingWorkspace(orcaPage, firstWorktreeId)
    const typingPtyId = await waitForActivePanePtyId(orcaPage)

    const pressureBeforeTyping = await deps.waitForMainPtyPressureBacklog(orcaPage)
    const measurement = await deps.measureTypingDuringLoad(
      orcaPage,
      typingScriptPath,
      typingPtyId,
      runId,
      'ptyWrite',
      maxWorstKeyLatencyMs
    )
    const debug = await deps.readTerminalPtyOutputDebug(orcaPage)
    const mainPressure = await deps.readMainPtyPressureDebug(orcaPage)
    const ackGate = await deps.readTerminalAckGateDebug(orcaPage)
    deps.annotateTypingMeasurement(
      testInfo,
      `opencode-hidden-real-pty-pressure-typing${annotationSuffix ?? ''}`,
      hiddenPanes.length + 1,
      measurement,
      debug,
      await deps.readTerminalOutputSchedulerDebug(orcaPage),
      mainPressure,
      ackGate
    )

    expect(debug?.hiddenRendererSkipCount ?? 0).toBe(0)
    expect(debug?.hiddenRendererSkippedChars ?? 0).toBe(0)
    expect(pressureBeforeTyping.peakPendingChars).toBeGreaterThan(0)
    expect(pressureBeforeTyping.sourcePausedPtyCount ?? 0).toBeGreaterThan(0)
    expect(
      (mainPressure?.peakRendererInFlightChars ?? 0) >= 8 * 1024 * 1024 ||
        (mainPressure?.sourcePausedPtyCount ?? 0) > 0
    ).toBe(true)
    expect(ackGate?.heldAckChars ?? 0).toBeGreaterThan(0)
    expect(measurement.medianLatencyMs).toBeLessThan(75)
    expect(measurement.worstLatencyMs).toBeLessThan(maxWorstKeyLatencyMs)
    expect(measurement.maxTimerDriftMs).toBeLessThan(250)

    await deps.releaseTerminalAckGate(orcaPage)
    const restoreLatencyMs = await measureHiddenOutputRestoreLatency(
      orcaPage,
      secondWorktreeId,
      hiddenPanes[0].ptyId,
      runId
    )
    await waitForMainSourcePauseRelease(orcaPage, deps.readMainPtyPressureDebug)
    testInfo.annotations.push({
      type: `opencode-hidden-real-pty-restore${annotationSuffix ?? ''}`,
      description: `panes=${hiddenPanes.length + 1} restore=${restoreLatencyMs.toFixed(
        1
      )}ms hiddenSkippedChars=${debug?.hiddenRendererSkippedChars ?? 0} mainPeakInFlightChars=${
        mainPressure?.peakRendererInFlightChars ?? 0
      } heldAckChars=${ackGate?.heldAckChars ?? 0}`
    })
    expect(restoreLatencyMs).toBeLessThan(MAX_HIDDEN_RESTORE_LATENCY_MS)
  } finally {
    await cleanupHiddenPressureScenario({
      deps,
      firstWorktreeId,
      hiddenPanes,
      orcaPage,
      pressureScriptPath,
      secondWorktreeId,
      typingScriptPath
    })
  }
}

async function waitForMainSourcePauseRelease<TMainPressure extends HiddenPressureMainSnapshot>(
  orcaPage: Page,
  readMainPtyPressureDebug: (page: Page) => Promise<TMainPressure | null>
): Promise<void> {
  await expect
    .poll(async () => (await readMainPtyPressureDebug(orcaPage))?.sourcePausedPtyCount ?? null, {
      timeout: 15_000,
      message: 'Main PTY source pause did not release after ACK gate release'
    })
    .toBe(0)
}

async function measureHiddenOutputRestoreLatency(
  orcaPage: Page,
  worktreeId: string,
  targetPtyId: string,
  runId: string
): Promise<number> {
  const restoreStart = performance.now()
  await switchToWorktree(orcaPage, worktreeId)
  await focusTerminalPaneForPtyId(orcaPage, targetPtyId)
  await expect
    .poll(() => getTerminalContentForPtyId(orcaPage, targetPtyId, 20_000), {
      timeout: 20_000,
      message: 'Hidden PTY output was not restored from main buffer on return'
    })
    .toContain(`OPENCODE_PRESSURE_DONE_${runId}_0`)
  return performance.now() - restoreStart
}

async function switchToTypingWorkspace(orcaPage: Page, worktreeId: string): Promise<void> {
  await switchToWorktree(orcaPage, worktreeId)
  await expect.poll(() => getActiveWorktreeId(orcaPage), { timeout: 10_000 }).toBe(worktreeId)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
}

async function cleanupHiddenPressureScenario<
  TMeasurement,
  TDebug,
  TScheduler,
  TMainPressure,
  TAckGate
>({
  deps,
  firstWorktreeId,
  hiddenPanes,
  orcaPage,
  pressureScriptPath,
  secondWorktreeId,
  typingScriptPath
}: {
  deps: HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  firstWorktreeId: string
  hiddenPanes: HiddenPressurePane[]
  orcaPage: Page
  pressureScriptPath: string
  secondWorktreeId: string
  typingScriptPath: string
}): Promise<void> {
  await deps.releaseTerminalAckGate(orcaPage)
  await switchToWorktree(orcaPage, firstWorktreeId).catch(() => undefined)
  await waitForActivePanePtyId(orcaPage)
    .then((ptyId) => sendToTerminal(orcaPage, ptyId, '\x03'))
    .catch(() => undefined)
  await switchToWorktree(orcaPage, secondWorktreeId).catch(() => undefined)
  await Promise.all(
    hiddenPanes.map((pane) => sendToTerminal(orcaPage, pane.ptyId, '\x03').catch(() => undefined))
  )
  rmSync(typingScriptPath, { force: true })
  rmSync(pressureScriptPath, { force: true })
}
