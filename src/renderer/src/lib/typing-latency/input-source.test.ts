import { describe, expect, it } from 'vitest'
import { createInputSourceTally } from './input-source'

describe('createInputSourceTally', () => {
  it('keeps exact source percentiles free of ambiguous bursts', () => {
    const tally = createInputSourceTally()
    tally.recordInput('direct', 'a')
    tally.recordInput('direct', 'b')
    tally.recordInput('ime', '한𠀀')
    tally.addObservation({
      attribution: 'single-input',
      source: 'direct',
      text: 'a',
      inputToDispatchMs: 1,
      dispatchToParseMs: 3,
      parseToPaintMs: 4,
      inputToPaintMs: 8,
      outputBytes: 20,
      outputWrites: 1
    })
    tally.addObservation({
      attribution: 'ambiguous-burst',
      reason: 'overlapping-inputs',
      inputCount: 2,
      sourceCounts: { direct: 1, ime: 1 },
      firstOutputParseFromFirstDispatchMs: 10,
      firstOutputParseFromLastDispatchMs: 6,
      parseToPaintMs: 2,
      outputBatchBytes: 40,
      outputBatchWrites: 1
    })

    const breakdown = tally.breakdown()
    expect(breakdown.direct).toMatchObject({
      observedInputs: 2,
      exactInputs: 1,
      ambiguousInputs: 1
    })
    expect(breakdown.direct.inputToPaintMs).toEqual({ count: 1, p50: 8, p95: 8, max: 8 })
    expect(breakdown.ime).toMatchObject({
      observedInputs: 1,
      exactInputs: 0,
      ambiguousInputs: 1
    })
    expect(breakdown.ime.inputToPaintMs).toEqual({
      count: 0,
      p50: null,
      p95: null,
      max: null
    })
    expect(breakdown.imeCommitChars).toEqual({ count: 1, p50: 2, p95: 2, max: 2 })
  })

  it('records an isolated IME commit as one exact source sample', () => {
    const tally = createInputSourceTally()
    tally.recordInput('ime', '한')
    tally.addObservation({
      attribution: 'single-input',
      source: 'ime',
      text: '한',
      inputToDispatchMs: 2,
      dispatchToParseMs: 7,
      parseToPaintMs: 3,
      inputToPaintMs: 12,
      outputBytes: 3,
      outputWrites: 1
    })

    expect(tally.breakdown().ime).toMatchObject({
      observedInputs: 1,
      exactInputs: 1,
      ambiguousInputs: 0,
      outputBytesPerInput: { count: 1, p50: 3, p95: 3, max: 3 }
    })
  })
})
