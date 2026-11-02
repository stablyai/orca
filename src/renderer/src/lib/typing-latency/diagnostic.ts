/** Run window.__orcaTypingDiagnostic.start(), type ~20s, report(), then stop() on the affected machine. Census links echo lag to rows/listeners/settings/focused agent; input instrumentation exists only between start/stop. */
import {
  detachPaneEcho,
  discardUndispatchedKeystroke,
  drainTimedOutEchoCandidates,
  findPaneOwningFocus,
  findPaneOwningNode,
  instrumentPaneEcho,
  listProbePanes,
  noteEchoOutputArrival,
  recordKeystroke,
  type EchoObservation,
  type InstrumentedPane
} from './echo-instrumentation'
import { setTerminalOutputArrivalObserver } from '@/lib/pane-manager/terminal-output-arrival-observer'
import { observeRendererLongTasks } from './renderer-long-tasks'
import {
  buildTypingLatencyReport,
  type ProbeState,
  type TypingLatencyReport
} from './diagnostic-report'
import { installTypingLatencyInputEvents } from './input-events'
import { createInputSourceTally } from './input-source'
import {
  appendExactLatencySample,
  appendTypingLatencySample,
  createExactLatencySampleWindow,
  TYPING_LATENCY_SAMPLE_LIMIT
} from './sample-window'

export type { TypingLatencyReport } from './diagnostic-report'

let active: ProbeState | null = null
let lastState: ProbeState | null = null
let cachedAppVersion: string | null = null

function recordObservation(state: ProbeState, observation: EchoObservation): void {
  if (observation.attribution === 'single-input') {
    state.exactInputs += 1
    appendExactLatencySample(state.exact, observation)
    state.exactSamples.push({
      startedAt: observation.startedAt,
      paintedAt: observation.paintedAt,
      inputToPaintMs: observation.inputToPaintMs,
      eventToPaintMs: observation.eventToPaintMs,
      eventToHandlerMs: observation.eventToHandlerMs,
      inputToDispatchMs: observation.inputToDispatchMs,
      dispatchToArrivalMs: observation.dispatchToArrivalMs,
      arrivalToWriteMs: observation.arrivalToWriteMs,
      writeToParseMs: observation.writeToParseMs,
      parseToPaintMs: observation.parseToPaintMs
    })
    if (state.exactSamples.length > TYPING_LATENCY_SAMPLE_LIMIT) {
      state.exactSamples.shift()
    }
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

/** Composition-end events are synthesized by Orca, so their timestamps say nothing about queueing. */
function readTrustedEventTime(event: Event, handledAt: number): number | null {
  const at = event.timeStamp
  return event.isTrusted && Number.isFinite(at) && at > 0 && at <= handledAt ? at : null
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
    exactSamples: [],
    longTasks: observeRendererLongTasks(),
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
  const paneByTerminal = new Map<unknown, InstrumentedPane>()
  for (const entry of state.panes) {
    if (entry.pane?.terminal) {
      paneByTerminal.set(entry.pane.terminal, entry)
    }
  }
  setTerminalOutputArrivalObserver((terminal) => {
    const entry = paneByTerminal.get(terminal)
    if (entry) {
      noteEchoOutputArrival(entry, performance.now())
    }
  })

  state.detachInputEvents = installTypingLatencyInputEvents(window, (signal) => {
    const eventTarget = signal.event.target instanceof Node ? signal.event.target : null
    const target = findPaneOwningNode(state.panes, eventTarget) ?? findPaneOwningFocus(state.panes)
    if (!target) {
      state.keystrokesWithoutTerminalFocus += 1
      return undefined
    }
    const recordedAt = performance.now()
    const recorded = recordKeystroke(
      target,
      recordedAt,
      signal.source,
      readTrustedEventTime(signal.event, recordedAt)
    )
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
  setTerminalOutputArrivalObserver(null)
  state.longTasks.dispose()
  for (const entry of state.panes) {
    state.unmatchedKeystrokes += detachPaneEcho(entry)
  }
  state.panes = []
  return 'Typing diagnostic stopped. Run __orcaTypingDiagnostic.report() to read the last samples.'
}

function reportProbe(): TypingLatencyReport {
  if (active) {
    active.longTasks.flush()
    const now = performance.now()
    for (const entry of active.panes) {
      active.unmatchedKeystrokes += drainTimedOutEchoCandidates(entry, now)
    }
  }
  const report = buildTypingLatencyReport(active ?? lastState, active !== null, cachedAppVersion)
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
