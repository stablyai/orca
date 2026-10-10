/**
 * One-paste typing-latency self-diagnostic:
 *
 *   window.__orcaTypingDiagnostic.start()   // then type normally for ~20s
 *   window.__orcaTypingDiagnostic.report()  // logs + returns a JSON-safe object
 *   window.__orcaTypingDiagnostic.stop()
 *
 * Why: keystroke-echo lag reproduces on one user's machine only, so the
 * measurement has to run THERE. The census answers what a user cannot: agent-row
 * scale, store listener count, suspect settings, and which agent/screen mode the
 * focused pane is in.
 *
 * Nothing attaches to the keystroke path until start(); stop() detaches all of it.
 */
import {
  countMountedAgentRows,
  readFocusedPaneCensus,
  readProbeStoreState,
  readStoreListenerCount
} from './census-probe'
import {
  detachPaneEcho,
  discardUndispatchedKeystroke,
  drainTimedOutEchoCandidates,
  findPaneOwningFocus,
  findPaneOwningNode,
  instrumentPaneEcho,
  listProbePanes,
  recordKeystroke,
  type EchoObservation,
  type InstrumentedPane
} from './echo-instrumentation'
import {
  summarizeLatencySamples,
  summarizeTypingScaleCensus,
  typingSampleDurationMs,
  type LatencyPercentiles,
  type TypingScaleCensus
} from './diagnostic-summary'
import { installTypingLatencyInputEvents } from './input-events'
import {
  createInputSourceTally,
  emptyInputSourceBreakdown,
  type InputSourceBreakdown,
  type InputSourceTally
} from './input-source'
import {
  appendExactLatencySample,
  appendTypingLatencySample,
  createExactLatencySampleWindow,
  type ExactLatencySampleWindow
} from './sample-window'

type AmbiguousBurstState = {
  inputCounts: number[]
  firstOutputParseFromFirstDispatchMs: number[]
  firstOutputParseFromLastDispatchMs: number[]
  parseToPaintMs: number[]
  outputBytes: number[]
  outputWrites: number[]
}

type ProbeState = {
  startedAt: number
  stoppedAt: number | null
  startedAtIso: string
  exact: ExactLatencySampleWindow
  ambiguous: AmbiguousBurstState
  exactInputs: number
  ambiguousInputs: number
  ambiguousBurstCount: number
  attributionGapBursts: number
  unmatchedKeystrokes: number
  keystrokesWithoutTerminalFocus: number
  instrumentedPaneCount: number
  panes: InstrumentedPane[]
  detachInputEvents: () => void
  byInputSource: InputSourceTally
}

let active: ProbeState | null = null
let lastState: ProbeState | null = null
let cachedAppVersion: string | null = null

export type TypingLatencyReport = {
  capturedAt: string
  sampling: {
    running: boolean
    startedAt: string | null
    durationMs: number | null
    keystrokesWithoutTerminalFocus: number
    unmatchedKeystrokes: number
    exactInputs: number
    ambiguousInputs: number
    ambiguousBursts: number
    attributionGapBursts: number
    instrumentedPanes: number
  }
  exact: {
    inputToDispatchMs: LatencyPercentiles
    dispatchToParseMs: LatencyPercentiles
    parseToPaintMs: LatencyPercentiles
    inputToPaintMs: LatencyPercentiles
    outputBytesPerInput: LatencyPercentiles
    outputWritesPerInput: LatencyPercentiles
  }
  ambiguousBursts: {
    inputCount: LatencyPercentiles
    firstOutputParseFromFirstDispatchMs: LatencyPercentiles
    firstOutputParseFromLastDispatchMs: LatencyPercentiles
    parseToPaintMs: LatencyPercentiles
    outputBatchBytes: LatencyPercentiles
    outputBatchWrites: LatencyPercentiles
  }
  byInputSource: InputSourceBreakdown
  census: TypingScaleCensus
}

function buildReport(state: ProbeState | null, running: boolean): TypingLatencyReport {
  return {
    capturedAt: new Date().toISOString(),
    sampling: {
      running,
      startedAt: state?.startedAtIso ?? null,
      durationMs: typingSampleDurationMs(
        state?.startedAt ?? null,
        state?.stoppedAt ?? null,
        performance.now()
      ),
      keystrokesWithoutTerminalFocus: state?.keystrokesWithoutTerminalFocus ?? 0,
      unmatchedKeystrokes: state?.unmatchedKeystrokes ?? 0,
      exactInputs: state?.exactInputs ?? 0,
      ambiguousInputs: state?.ambiguousInputs ?? 0,
      ambiguousBursts: state?.ambiguousBurstCount ?? 0,
      attributionGapBursts: state?.attributionGapBursts ?? 0,
      instrumentedPanes: state?.instrumentedPaneCount ?? 0
    },
    exact: {
      inputToDispatchMs: summarizeLatencySamples(state?.exact.inputToDispatchMs ?? []),
      dispatchToParseMs: summarizeLatencySamples(state?.exact.dispatchToParseMs ?? []),
      parseToPaintMs: summarizeLatencySamples(state?.exact.parseToPaintMs ?? []),
      inputToPaintMs: summarizeLatencySamples(state?.exact.inputToPaintMs ?? []),
      outputBytesPerInput: summarizeLatencySamples(state?.exact.outputBytes ?? []),
      outputWritesPerInput: summarizeLatencySamples(state?.exact.outputWrites ?? [])
    },
    ambiguousBursts: {
      inputCount: summarizeLatencySamples(state?.ambiguous.inputCounts ?? []),
      firstOutputParseFromFirstDispatchMs: summarizeLatencySamples(
        state?.ambiguous.firstOutputParseFromFirstDispatchMs ?? []
      ),
      firstOutputParseFromLastDispatchMs: summarizeLatencySamples(
        state?.ambiguous.firstOutputParseFromLastDispatchMs ?? []
      ),
      parseToPaintMs: summarizeLatencySamples(state?.ambiguous.parseToPaintMs ?? []),
      outputBatchBytes: summarizeLatencySamples(state?.ambiguous.outputBytes ?? []),
      outputBatchWrites: summarizeLatencySamples(state?.ambiguous.outputWrites ?? [])
    },
    byInputSource: state?.byInputSource.breakdown() ?? emptyInputSourceBreakdown(),
    census: summarizeTypingScaleCensus({
      state: readProbeStoreState(),
      appVersion: cachedAppVersion,
      livePaneCount: listProbePanes().length,
      instrumentedPaneCount: state?.instrumentedPaneCount ?? 0,
      mountedAgentRowCount: countMountedAgentRows(),
      storeListenerCount: readStoreListenerCount(),
      focusedPane: readFocusedPaneCensus()
    })
  }
}

function recordObservation(state: ProbeState, observation: EchoObservation): void {
  if (observation.attribution === 'single-input') {
    state.exactInputs += 1
    appendExactLatencySample(state.exact, observation)
  } else {
    state.ambiguousInputs += observation.inputCount
    state.ambiguousBurstCount += 1
    state.attributionGapBursts += observation.reason === 'attribution-gap' ? 1 : 0
    appendTypingLatencySample(state.ambiguous.inputCounts, observation.inputCount)
    appendTypingLatencySample(
      state.ambiguous.firstOutputParseFromFirstDispatchMs,
      observation.firstOutputParseFromFirstDispatchMs
    )
    appendTypingLatencySample(
      state.ambiguous.firstOutputParseFromLastDispatchMs,
      observation.firstOutputParseFromLastDispatchMs
    )
    appendTypingLatencySample(state.ambiguous.parseToPaintMs, observation.parseToPaintMs)
    appendTypingLatencySample(state.ambiguous.outputBytes, observation.outputBatchBytes)
    appendTypingLatencySample(state.ambiguous.outputWrites, observation.outputBatchWrites)
  }
  state.byInputSource.addObservation(observation)
}

function cacheAppVersion(): void {
  void window.api?.updater
    ?.getVersion?.()
    .then((version) => {
      cachedAppVersion = version
    })
    .catch(() => undefined)
}

function startProbe(): string {
  if (active) {
    return 'Typing diagnostic already running. Type for ~20s, then run __orcaTypingDiagnostic.report().'
  }
  cacheAppVersion()

  const state: ProbeState = {
    startedAt: performance.now(),
    stoppedAt: null,
    startedAtIso: new Date().toISOString(),
    exact: createExactLatencySampleWindow(),
    ambiguous: {
      inputCounts: [],
      firstOutputParseFromFirstDispatchMs: [],
      firstOutputParseFromLastDispatchMs: [],
      parseToPaintMs: [],
      outputBytes: [],
      outputWrites: []
    },
    exactInputs: 0,
    ambiguousInputs: 0,
    ambiguousBurstCount: 0,
    attributionGapBursts: 0,
    unmatchedKeystrokes: 0,
    keystrokesWithoutTerminalFocus: 0,
    instrumentedPaneCount: 0,
    panes: [],
    detachInputEvents: () => undefined,
    byInputSource: createInputSourceTally()
  }
  state.panes = listProbePanes().map((pane) =>
    instrumentPaneEcho(pane, (observation) => recordObservation(state, observation))
  )
  state.instrumentedPaneCount = state.panes.length

  state.detachInputEvents = installTypingLatencyInputEvents(window, (signal) => {
    const eventTarget = signal.event.target instanceof Node ? signal.event.target : null
    const target = findPaneOwningNode(state.panes, eventTarget) ?? findPaneOwningFocus(state.panes)
    if (!target) {
      state.keystrokesWithoutTerminalFocus += 1
      return undefined
    }
    const recordedAt = performance.now()
    const recorded = recordKeystroke(target, recordedAt, signal.source, signal.text)
    state.unmatchedKeystrokes += recorded.unmatched
    if (signal.source === 'ime') {
      return {
        settleAfterPropagation: (defaultPrevented) => {
          const discardResult = defaultPrevented
            ? discardUndispatchedKeystroke(target, recorded.candidate)
            : null
          if (discardResult === null) {
            state.byInputSource.recordInput(signal.source, signal.text)
          } else if (discardResult === 'counted-unmatched') {
            state.unmatchedKeystrokes = Math.max(0, state.unmatchedKeystrokes - 1)
          }
        }
      }
    }
    state.byInputSource.recordInput(signal.source, signal.text)
    return undefined
  })

  active = state
  lastState = state
  return `Typing diagnostic started on ${state.panes.length} pane(s). Click into the agent terminal, type normally for ~20 seconds, then run __orcaTypingDiagnostic.report().`
}

function stopProbe(): string {
  const state = active
  if (!state) {
    return 'Typing diagnostic was not running.'
  }
  active = null
  state.stoppedAt = performance.now()
  state.instrumentedPaneCount = state.panes.length
  state.detachInputEvents()
  state.detachInputEvents = () => undefined
  for (const entry of state.panes) {
    state.unmatchedKeystrokes += detachPaneEcho(entry)
  }
  state.panes = []
  return 'Typing diagnostic stopped. Run __orcaTypingDiagnostic.report() to read the last samples.'
}

function reportProbe(): TypingLatencyReport {
  if (active) {
    const now = performance.now()
    for (const entry of active.panes) {
      active.unmatchedKeystrokes += drainTimedOutEchoCandidates(entry, now)
    }
  }
  const report = buildReport(active ?? lastState, active !== null)
  console.log('[orca] typing latency diagnostic', report)
  return report
}

export type TypingDiagnosticBridge = {
  start: () => string
  stop: () => string
  report: () => TypingLatencyReport
}

type TypingDiagnosticWindow = Window & { __orcaTypingDiagnostic?: TypingDiagnosticBridge }

export function installTypingLatencyDiagnostic(): void {
  if (typeof window === 'undefined') {
    return
  }
  const target = window as TypingDiagnosticWindow
  if (target.__orcaTypingDiagnostic) {
    return
  }
  target.__orcaTypingDiagnostic = { start: startProbe, stop: stopProbe, report: reportProbe }
}
