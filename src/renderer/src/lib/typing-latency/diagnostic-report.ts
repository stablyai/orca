import {
  countMountedAgentRows,
  readFocusedPaneCensus,
  readProbeStoreState,
  readStoreListenerCount
} from './census-probe'
import {
  summarizeLatencySamples,
  summarizeTypingScaleCensus,
  typingSampleDurationMs,
  type LatencyPercentiles,
  type TypingScaleCensus
} from './diagnostic-summary'
import { listProbePanes, type ExactEchoSample, type InstrumentedPane } from './echo-instrumentation'
import {
  emptyInputSourceBreakdown,
  type InputSourceBreakdown,
  type InputSourceTally
} from './input-source'
import {
  summarizeLongTaskOverlap,
  type LongTaskOverlapReport,
  type RendererLongTaskLog
} from './renderer-long-tasks'
import type { ExactLatencySampleWindow } from './sample-window'

export type AmbiguousBurstState = {
  inputCounts: number[]
  firstOutputParseFromFirstDispatchMs: number[]
  firstOutputParseFromLastDispatchMs: number[]
  parseToPaintMs: number[]
  outputBytes: number[]
  outputWrites: number[]
}

export type ProbeState = {
  startedAt: number
  stoppedAt: number | null
  startedAtIso: string
  exact: ExactLatencySampleWindow
  exactSamples: ExactEchoSample[]
  longTasks: RendererLongTaskLog
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
    /** Trusted DOM event time to the probe's capture handler: input queued behind other renderer work. */
    eventToHandlerMs: LatencyPercentiles
    eventToPaintMs: LatencyPercentiles
    /** dispatchToParseMs split: PTY/main/IPC round trip, renderer scheduler queueing, xterm parse. */
    dispatchToArrivalMs: LatencyPercentiles
    arrivalToWriteMs: LatencyPercentiles
    writeToParseMs: LatencyPercentiles
    outputBytesPerInput: LatencyPercentiles
    outputWritesPerInput: LatencyPercentiles
  }
  longTaskOverlap: LongTaskOverlapReport
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

export function buildTypingLatencyReport(
  state: ProbeState | null,
  running: boolean,
  appVersion: string | null
): TypingLatencyReport {
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
      eventToHandlerMs: summarizeLatencySamples(state?.exact.eventToHandlerMs ?? []),
      eventToPaintMs: summarizeLatencySamples(state?.exact.eventToPaintMs ?? []),
      dispatchToArrivalMs: summarizeLatencySamples(state?.exact.dispatchToArrivalMs ?? []),
      arrivalToWriteMs: summarizeLatencySamples(state?.exact.arrivalToWriteMs ?? []),
      writeToParseMs: summarizeLatencySamples(state?.exact.writeToParseMs ?? []),
      outputBytesPerInput: summarizeLatencySamples(state?.exact.outputBytes ?? []),
      outputWritesPerInput: summarizeLatencySamples(state?.exact.outputWrites ?? [])
    },
    longTaskOverlap: summarizeLongTaskOverlap(
      state?.longTasks.source ?? 'unavailable',
      state?.longTasks.tasks ?? [],
      state?.exactSamples ?? [],
      state?.longTasks
    ),
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
      appVersion,
      livePaneCount: listProbePanes().length,
      instrumentedPaneCount: state?.instrumentedPaneCount ?? 0,
      mountedAgentRowCount: countMountedAgentRows(),
      storeListenerCount: readStoreListenerCount(),
      focusedPane: readFocusedPaneCensus()
    })
  }
}
