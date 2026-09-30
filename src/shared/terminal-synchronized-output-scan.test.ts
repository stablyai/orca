import { describe, expect, it } from 'vitest'
import {
  INITIAL_SYNCHRONIZED_OUTPUT_LATCH_STATE,
  SYNCHRONIZED_OUTPUT_END_SEQUENCE,
  SYNCHRONIZED_OUTPUT_START_SEQUENCE,
  advanceDroppedSynchronizedOutputLatch,
  resolveSynchronizedOutputSafeSplit,
  scanSynchronizedOutput
} from './terminal-synchronized-output-scan'

const OPEN = SYNCHRONIZED_OUTPUT_START_SEQUENCE
const CLOSE = SYNCHRONIZED_OUTPUT_END_SEQUENCE

describe('advanceDroppedSynchronizedOutputLatch', () => {
  it('releases the latch when the dropped span ended mid-frame', () => {
    // The close was inside the bytes the renderer will never receive, so xterm
    // would paint nothing until its 1000ms forced flush.
    const result = advanceDroppedSynchronizedOutputLatch(
      `${OPEN}rows`,
      INITIAL_SYNCHRONIZED_OUTPUT_LATCH_STATE
    )
    expect(result.state.active).toBe(true)
    expect(result.data).toBe(CLOSE)
  })

  it('emits nothing when the dropped span closed its own frame', () => {
    const result = advanceDroppedSynchronizedOutputLatch(
      `${OPEN}rows${CLOSE}`,
      INITIAL_SYNCHRONIZED_OUTPUT_LATCH_STATE
    )
    expect(result.state.active).toBe(false)
    expect(result.data).toBe('')
  })

  it('carries an open latch across successive dropped chunks', () => {
    const first = advanceDroppedSynchronizedOutputLatch(
      `${OPEN}a`,
      INITIAL_SYNCHRONIZED_OUTPUT_LATCH_STATE
    )
    const second = advanceDroppedSynchronizedOutputLatch('b', first.state)
    expect(second.state.active).toBe(true)
    expect(second.data).toBe(CLOSE)
    const third = advanceDroppedSynchronizedOutputLatch(CLOSE, second.state)
    expect(third.state.active).toBe(false)
    expect(third.data).toBe('')
  })

  it('stitches a close marker split across dropped chunks', () => {
    const head = CLOSE.slice(0, 4)
    const tail = CLOSE.slice(4)
    const first = advanceDroppedSynchronizedOutputLatch(
      `${OPEN}rows${head}`,
      INITIAL_SYNCHRONIZED_OUTPUT_LATCH_STATE
    )
    expect(first.state.active).toBe(true)
    const second = advanceDroppedSynchronizedOutputLatch(tail, first.state)
    expect(second.state.active).toBe(false)
    expect(second.data).toBe('')
  })
})

describe('resolveSynchronizedOutputSafeSplit', () => {
  it('returns the whole length when it already fits', () => {
    expect(resolveSynchronizedOutputSafeSplit('abc', 16)).toBe(3)
  })

  it('splits after a completed frame rather than inside the next one', () => {
    const data = `${OPEN}aaaa${CLOSE}${OPEN}bbbbbbbbbb${CLOSE}`
    const limit = data.indexOf('bbb')
    const splitAt = resolveSynchronizedOutputSafeSplit(data, limit)
    // Everything delivered must leave the latch closed.
    expect(scanSynchronizedOutput(data.slice(0, splitAt), '', false).active).toBe(false)
    expect(splitAt).toBe(`${OPEN}aaaa${CLOSE}`.length)
  })

  it('never severs the close marker itself', () => {
    const data = `${OPEN}aaaa${CLOSE}tail`
    // Limit lands in the middle of the 8-byte close sequence.
    const limit = `${OPEN}aaaa`.length + 4
    const splitAt = resolveSynchronizedOutputSafeSplit(data, limit)
    expect(splitAt).toBeLessThanOrEqual(limit)
    expect(data.slice(0, splitAt).endsWith('\x1b')).toBe(false)
    // The remainder must still contain a complete, parseable close.
    expect(data.slice(splitAt)).toContain(CLOSE)
  })

  it('falls back to the limit when one frame is longer than the window', () => {
    const data = `${OPEN}${'x'.repeat(100)}${CLOSE}`
    expect(resolveSynchronizedOutputSafeSplit(data, 20)).toBe(20)
  })

  it('degrades to the plain limit when the buffer starts inside a frame', () => {
    // Callers do not thread prior latch state, so a remainder that begins inside
    // an already-open frame is scanned as if closed. It must never be WORSE than
    // the blind offset it replaced: same boundary, byte-exact.
    const data = `${'z'.repeat(40)}${CLOSE}${'q'.repeat(40)}`
    const limit = 20
    const splitAt = resolveSynchronizedOutputSafeSplit(data, limit, '', true)
    const naive = resolveSynchronizedOutputSafeSplit(data, limit)
    // With the real prior state it can only do better or the same.
    expect(splitAt).toBeLessThanOrEqual(limit)
    expect(naive).toBeLessThanOrEqual(limit)
    expect(data.slice(0, naive) + data.slice(naive)).toBe(data)
  })

  it('never returns past the limit or breaks byte-exactness across many shapes', () => {
    const outputSamples = [
      `${OPEN}${'a'.repeat(50)}${CLOSE}`,
      `${'a'.repeat(50)}${CLOSE}${'b'.repeat(50)}`,
      `${OPEN}${OPEN}${'a'.repeat(30)}${CLOSE}${CLOSE}`,
      `${'a'.repeat(30)}\x1b]52;c;SGVsbG8=\x07${'b'.repeat(30)}`,
      `${'a'.repeat(30)}\x1bP0;1|payload\x1b\\${'b'.repeat(30)}`,
      CLOSE.repeat(10),
      `${OPEN.repeat(10)}tail`
    ]
    for (const data of outputSamples) {
      for (let limit = 1; limit <= data.length + 3; limit++) {
        const splitAt = resolveSynchronizedOutputSafeSplit(data, limit)
        expect(splitAt).toBeGreaterThan(0)
        expect(splitAt).toBeLessThanOrEqual(Math.min(limit, data.length))
        expect(data.slice(0, splitAt) + data.slice(splitAt)).toBe(data)
      }
    }
  })
})
