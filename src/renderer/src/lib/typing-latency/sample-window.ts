import type { ExactEchoSample } from './echo-observation'

const TYPING_LATENCY_SAMPLE_LIMIT = 2000

export type ExactLatencySampleWindow = {
  inputToDispatchMs: number[]
  dispatchToParseMs: number[]
  parseToPaintMs: number[]
  inputToPaintMs: number[]
  outputBytes: number[]
  outputWrites: number[]
}

export function createExactLatencySampleWindow(): ExactLatencySampleWindow {
  return {
    inputToDispatchMs: [],
    dispatchToParseMs: [],
    parseToPaintMs: [],
    inputToPaintMs: [],
    outputBytes: [],
    outputWrites: []
  }
}

export function appendTypingLatencySample(values: number[], value: number): void {
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
  appendTypingLatencySample(samples.outputBytes, sample.outputBytes)
  appendTypingLatencySample(samples.outputWrites, sample.outputWrites)
}
