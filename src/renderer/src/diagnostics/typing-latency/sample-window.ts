import type { ExactEchoSample } from './echo-observation'

export const TYPING_LATENCY_SAMPLE_LIMIT = 2000

export type ExactLatencySampleWindow = {
  inputToDispatchMs: number[]
  dispatchToParseMs: number[]
  parseToPaintMs: number[]
  inputToPaintMs: number[]
  eventToHandlerMs: (number | null)[]
  eventToPaintMs: (number | null)[]
  dispatchToArrivalMs: (number | null)[]
  arrivalToWriteMs: (number | null)[]
  writeToParseMs: (number | null)[]
  outputBytes: number[]
  outputWrites: number[]
}

export function createExactLatencySampleWindow(): ExactLatencySampleWindow {
  return {
    inputToDispatchMs: [],
    dispatchToParseMs: [],
    parseToPaintMs: [],
    inputToPaintMs: [],
    eventToHandlerMs: [],
    eventToPaintMs: [],
    dispatchToArrivalMs: [],
    arrivalToWriteMs: [],
    writeToParseMs: [],
    outputBytes: [],
    outputWrites: []
  }
}

export function appendTypingLatencySample<T extends number | null>(values: T[], value: T): void {
  values.push(value)
  if (values.length > TYPING_LATENCY_SAMPLE_LIMIT) {
    values.shift()
  }
}

export function appendExactLatencySample(
  samples: ExactLatencySampleWindow,
  sample: ExactEchoSample
): void {
  appendTypingLatencySample(samples.inputToDispatchMs, sample.inputToDispatchMs)
  appendTypingLatencySample(samples.dispatchToParseMs, sample.dispatchToParseMs)
  appendTypingLatencySample(samples.parseToPaintMs, sample.parseToPaintMs)
  appendTypingLatencySample(samples.inputToPaintMs, sample.inputToPaintMs)
  appendTypingLatencySample(samples.eventToHandlerMs, sample.eventToHandlerMs)
  appendTypingLatencySample(samples.eventToPaintMs, sample.eventToPaintMs)
  appendTypingLatencySample(samples.dispatchToArrivalMs, sample.dispatchToArrivalMs)
  appendTypingLatencySample(samples.arrivalToWriteMs, sample.arrivalToWriteMs)
  appendTypingLatencySample(samples.writeToParseMs, sample.writeToParseMs)
  appendTypingLatencySample(samples.outputBytes, sample.outputBytes)
  appendTypingLatencySample(samples.outputWrites, sample.outputWrites)
}
