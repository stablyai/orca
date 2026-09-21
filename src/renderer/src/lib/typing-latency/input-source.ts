import { summarizeLatencySamples, type LatencyPercentiles } from './diagnostic-summary'
import type { EchoObservation, KeystrokeSource } from './echo-instrumentation'
import {
  appendExactLatencySample,
  appendTypingLatencySample,
  createExactLatencySampleWindow,
  type ExactLatencySampleWindow
} from './sample-window'

type SourceTally = {
  observedInputs: number
  exactInputs: number
  ambiguousInputs: number
  exact: ExactLatencySampleWindow
}

export type InputSourceLatency = {
  observedInputs: number
  exactInputs: number
  ambiguousInputs: number
  inputToDispatchMs: LatencyPercentiles
  dispatchToParseMs: LatencyPercentiles
  parseToPaintMs: LatencyPercentiles
  inputToPaintMs: LatencyPercentiles
  outputBytesPerInput: LatencyPercentiles
  outputWritesPerInput: LatencyPercentiles
}

export type InputSourceBreakdown = Record<KeystrokeSource, InputSourceLatency> & {
  imeCommitChars: LatencyPercentiles
}

export type InputSourceTally = {
  recordInput: (source: KeystrokeSource, text: string) => void
  addObservation: (observation: EchoObservation) => void
  breakdown: () => InputSourceBreakdown
}

function emptySourceTally(): SourceTally {
  return {
    observedInputs: 0,
    exactInputs: 0,
    ambiguousInputs: 0,
    exact: createExactLatencySampleWindow()
  }
}

function summarizeSource(tally: SourceTally): InputSourceLatency {
  return {
    observedInputs: tally.observedInputs,
    exactInputs: tally.exactInputs,
    ambiguousInputs: tally.ambiguousInputs,
    inputToDispatchMs: summarizeLatencySamples(tally.exact.inputToDispatchMs),
    dispatchToParseMs: summarizeLatencySamples(tally.exact.dispatchToParseMs),
    parseToPaintMs: summarizeLatencySamples(tally.exact.parseToPaintMs),
    inputToPaintMs: summarizeLatencySamples(tally.exact.inputToPaintMs),
    outputBytesPerInput: summarizeLatencySamples(tally.exact.outputBytes),
    outputWritesPerInput: summarizeLatencySamples(tally.exact.outputWrites)
  }
}

export function createInputSourceTally(): InputSourceTally {
  const bySource: Record<KeystrokeSource, SourceTally> = {
    direct: emptySourceTally(),
    ime: emptySourceTally()
  }
  const imeCommitChars: number[] = []
  return {
    recordInput: (source, text) => {
      bySource[source].observedInputs += 1
      if (source === 'ime' && text.length > 0) {
        appendTypingLatencySample(imeCommitChars, Array.from(text).length)
      }
    },
    addObservation: (observation) => {
      if (observation.attribution === 'single-input') {
        bySource[observation.source].exactInputs += 1
        appendExactLatencySample(bySource[observation.source].exact, observation)
        return
      }
      bySource.direct.ambiguousInputs += observation.sourceCounts.direct
      bySource.ime.ambiguousInputs += observation.sourceCounts.ime
    },
    breakdown: () => ({
      direct: summarizeSource(bySource.direct),
      ime: summarizeSource(bySource.ime),
      imeCommitChars: summarizeLatencySamples(imeCommitChars)
    })
  }
}

export function emptyInputSourceBreakdown(): InputSourceBreakdown {
  return createInputSourceTally().breakdown()
}
