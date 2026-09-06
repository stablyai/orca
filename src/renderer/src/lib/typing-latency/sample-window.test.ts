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
        dispatchToParseMs: value,
        parseToPaintMs: value,
        inputToPaintMs: value,
        outputBytes: value,
        outputWrites: value
      })
    }

    for (const values of Object.values(samples)) {
      expect(values).toHaveLength(2000)
      expect(values[0]).toBe(1)
      expect(values.at(-1)).toBe(2000)
    }
  })
})
