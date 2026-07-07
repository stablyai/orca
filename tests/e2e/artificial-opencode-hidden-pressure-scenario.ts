import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

type HiddenPressurePane = {
  ptyId: string
}

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
}

type HiddenPressureAckGate = {
  heldAckChars: number
}

// Why: this is a throughput/drain metric — the time to switch back and replay the
// full 8MB+ held backlog into xterm, measured through repeated (expensive) terminal
// serialization polls. The real responsiveness guards are the typing-latency
// asserts above (median/worst), which hold. Under 8MB of in-flight backpressure on
// a loaded OSS runner the drain-plus-poll overhead was seen at ~3.2s, so keep a
// ceiling with headroom that still catches an order-of-magnitude regression.
const MAX_HIDDEN_RESTORE_LATENCY_MS = 4_000
// Why: in this hidden real-PTY pressure case, maxTimerDriftMs and worst-key
// latency catch the same isolated CI starvation spike; median remains strict.
const MAX_HIDDEN_PRESSURE_TIMER_DRIFT_MS = 3_000

export function pressureOutputScript(runId: string): string {
  return `
const paneIndex = process.argv[2] ?? '0'
const targetChars = Number(process.argv[3] ?? '0')
const delayMs = Number(process.argv[4] ?? '0')
const header = 'OPENCODE_PRESSURE_START_${runId}_' + paneIndex + '\\n'
const chunkBody = '#'.repeat(8192)
let written = 0
process.stdout.write(header)
function writeMore() {
  let canContinue = true
  while (canContinue && written < targetChars) {
    const frame = String(written).padStart(8, '0')
    const chunk = '\\x1b[?2026h\\x1b[1;1Hpressure pane=' + paneIndex + ' frame=' + frame + ' ' + chunkBody + '\\x1b[?2026l\\n'
    written += chunk.length
    canContinue = process.stdout.write(chunk)
  }
  if (written < targetChars) {
    process.stdout.once('drain', writeMore)
    return
  }
  process.stdout.write('OPENCODE_PRESSURE_DONE_${runId}_' + paneIndex + '\\n')
}
setTimeout(writeMore, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0)
`
}

export function writePressureOutputScript(scriptPath: string, runId: string): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, pressureOutputScript(runId))
}

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
  testInfo,
  testRepoPath,
  orcaPage
}: {
  deps: HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  annotationSuffix?: string
  hiddenPaneCount: number
  pressureOutputChars: number
  pressureStartDelayMs: number
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
      runId
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
    expect(pressureBeforeTyping.ackGatedFlushSkipCount).toBeGreaterThan(0)
    expect(mainPressure?.peakRendererInFlightChars ?? 0).toBeGreaterThanOrEqual(8 * 1024 * 1024)
    expect(ackGate?.heldAckChars ?? 0).toBeGreaterThan(0)
    // Why: median is the robust responsiveness guard — it proves typing stays
    // instant even while hidden PTYs replay 8MB+ of ACK-backpressured output.
    expect(measurement.medianLatencyMs).toBeLessThan(75)
    // Why: worst *single-key echo* under 8MB synthetic backpressure lands behind
    // whichever flush it collides with, so on a contended OSS shard it is
    // environment-dominated (seen at ~2s). Keep it only as a catastrophic-hang
    // detector — the original regression (input freezing for seconds) shows up in
    // the median too. Aligns with ssh-docker-relay-perf's 2s worst-key tolerance.
    expect(measurement.worstLatencyMs).toBeLessThan(3_000)
    expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_HIDDEN_PRESSURE_TIMER_DRIFT_MS)

    await deps.releaseTerminalAckGate(orcaPage)
    const restoreLatencyMs = await measureHiddenOutputRestoreLatency(
      orcaPage,
      secondWorktreeId,
      runId
    )
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

async function measureHiddenOutputRestoreLatency(
  orcaPage: Page,
  worktreeId: string,
  runId: string
): Promise<number> {
  const restoreStart = performance.now()
  await switchToWorktree(orcaPage, worktreeId)
  await expect
    .poll(() => getTerminalContent(orcaPage, 20_000), {
      timeout: 20_000,
      message: 'Hidden PTY output was not restored from main buffer on return'
    })
    .toContain(`OPENCODE_PRESSURE_DONE_${runId}_`)
  return performance.now() - restoreStart
}

async function startHiddenPressureCommands({
  hiddenPanes,
  orcaPage,
  pressureOutputChars,
  pressureScriptPath,
  pressureStartDelayMs
}: {
  hiddenPanes: HiddenPressurePane[]
  orcaPage: Page
  pressureOutputChars: number
  pressureScriptPath: string
  pressureStartDelayMs: number
}): Promise<void> {
  await Promise.all(
    hiddenPanes.map((pane, paneIndex) =>
      sendToTerminal(
        orcaPage,
        pane.ptyId,
        `node ${JSON.stringify(pressureScriptPath)} ${paneIndex} ${pressureOutputChars} ${pressureStartDelayMs}\r`
      )
    )
  )
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
