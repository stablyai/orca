import { describe, expect, it } from 'vitest'
import { appendExactLatencySample, createExactLatencySampleWindow } from './sample-window'
import type { ExactEchoSample } from './echo-observation'
import { summarizeLatencySamples } from './diagnostic-summary'

function exactSample(value: number): ExactEchoSample {
  return {
    attribution: 'single-input',
    source: 'direct',
    inputToDispatchMs: value,
    dispatchToParseMs: value + 10000,
    parseToPaintMs: value + 20000,
    inputToPaintMs: 3 * value + 30000,
    eventToHandlerMs: null,
    eventToPaintMs: null,
    dispatchToArrivalMs: null,
    arrivalToWriteMs: null,
    writeToParseMs: null,
    startedAt: value,
    paintedAt: 3 * value + 30000,
    outputBytes: value + 40000,
    outputWrites: value + 5000
  }
}

describe('typing latency sample window', () => {
  it('retains the newest 2000 exact samples in every percentile series', () => {
    const samples = createExactLatencySampleWindow()

    for (let value = 0; value <= 2000; value += 1) {
      appendExactLatencySample(samples, exactSample(value))
    }

    for (const [values, first, last] of [
      [samples.inputToDispatchMs, 1, 2000],
      [samples.dispatchToParseMs, 10_001, 12_000],
      [samples.parseToPaintMs, 20_001, 22_000],
      [samples.inputToPaintMs, 30_003, 36_000],
      [samples.outputBytes, 40_001, 42_000],
      [samples.outputWrites, 5001, 7000]
    ] as const) {
      expect(values).toHaveLength(2000)
      expect(values[0]).toBe(first)
      expect(values.at(-1)).toBe(last)
    }
  })

  it('expires optional phases with their inputs across mixed direct and IME captures', () => {
    const samples = createExactLatencySampleWindow()
    const optionalFields = [
      'eventToHandlerMs',
      'eventToPaintMs',
      'dispatchToArrivalMs',
      'arrivalToWriteMs',
      'writeToParseMs'
    ] as const
    appendExactLatencySample(samples, {
      ...exactSample(0),
      eventToHandlerMs: 999,
      eventToPaintMs: 999,
      dispatchToArrivalMs: 999,
      arrivalToWriteMs: 999,
      writeToParseMs: 999
    })
    for (let value = 1; value < 2000; value += 1) {
      appendExactLatencySample(samples, { ...exactSample(value), source: 'ime' })
    }
    for (const field of optionalFields) {
      expect(summarizeLatencySamples(samples[field])).toEqual({
        count: 1,
        p50: 999,
        p95: 999,
        max: 999
      })
    }

    appendExactLatencySample(samples, {
      ...exactSample(2000),
      eventToHandlerMs: 0,
      dispatchToArrivalMs: 3,
      writeToParseMs: 5
    })
    for (const [field, value] of [
      ['eventToHandlerMs', 0],
      ['eventToPaintMs', null],
      ['dispatchToArrivalMs', 3],
      ['arrivalToWriteMs', null],
      ['writeToParseMs', 5]
    ] as const) {
      expect(samples[field]).toHaveLength(2000)
      expect(summarizeLatencySamples(samples[field])).toEqual({
        count: value === null ? 0 : 1,
        p50: value,
        p95: value,
        max: value
      })
    }

    for (let value = 2001; value <= 4000; value += 1) {
      appendExactLatencySample(samples, { ...exactSample(value), source: 'ime' })
    }
    for (const field of optionalFields) {
      expect(summarizeLatencySamples(samples[field])).toEqual({
        count: 0,
        p50: null,
        p95: null,
        max: null
      })
    }
  })
})
