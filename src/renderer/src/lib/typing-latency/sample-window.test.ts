import { describe, expect, it } from 'vitest'
import { appendExactLatencySample, createExactLatencySampleWindow } from './sample-window'

describe('typing latency sample window', () => {
  it('retains the newest 2000 exact samples in every percentile series', () => {
    const samples = createExactLatencySampleWindow()

    for (let value = 0; value <= 2000; value += 1) {
      appendExactLatencySample(samples, {
        attribution: 'single-input',
        source: 'direct',
        text: 'a',
        inputToDispatchMs: value,
        dispatchToParseMs: value + 10000,
        parseToPaintMs: value + 20000,
        inputToPaintMs: 3 * value + 30000,
        outputBytes: value + 40000,
        outputWrites: value + 5000
      })
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
})
