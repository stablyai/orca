import { describe, expect, it } from 'vitest'
import {
  keptSuffixMeta,
  streamDeliveryOf,
  TerminalStreamPosition,
  type StreamDelivery
} from './terminal-stream-position'

const PTY = 'pty-1'

function at(startSeq: number, data: string, flags: Partial<StreamDelivery> = {}): StreamDelivery {
  return {
    startSeq,
    endSeq: startSeq + data.length,
    startsAtGround: true,
    boundaryUnknown: false,
    ...flags
  }
}

describe('TerminalStreamPosition', () => {
  it('writes a fresh stream and its exact continuations, split escapes included', () => {
    const position = new TerminalStreamPosition()
    expect(position.admit(PTY, 'ab\x1b[4', at(0, 'ab\x1b[4'))).toBe('ab\x1b[4')
    // The continuation completes ESC[42B; it is contiguous, so its mid-escape start is fine.
    expect(position.admit(PTY, '2Bc', at(5, '2Bc', { startsAtGround: false }))).toBe('2Bc')
  })

  it('skips a delivery that resumes inside an escape after lost bytes', () => {
    const position = new TerminalStreamPosition()
    position.admit(PTY, 'frame', at(0, 'frame'))
    // Bytes 5..17 (`\x1b[H\r\x1b[15C\x1b[`) never reached xterm.
    expect(
      position.admit(PTY, '42B\x1b[K', at(17, '42B\x1b[K', { startsAtGround: false }))
    ).toBeNull()
    expect(position.admit(PTY, 'next', at(24, 'next'))).toBe('\x18next')
  })

  it('re-arms an escape the replay omitted for a chunk cut at its seq (#33766)', () => {
    const position = new TerminalStreamPosition()
    position.anchor(PTY, 100, '')
    const cut = { startsAtGround: false, boundaryUnknown: true, cutEscapeTail: '\x1b[' }
    expect(position.admit(PTY, '>4;2m', at(100, '>4;2m', cut))).toBe('\x1b[>4;2m')
    // Only the delivery at the replay's own seq re-arms.
    expect(position.admit(PTY, '>4;2m', at(105, '>4;2m', cut))).toBe('>4;2m')
  })

  it('leaves a cut as it is when the replay re-armed a tail or did not say', () => {
    const cut = { startsAtGround: false, boundaryUnknown: true, cutEscapeTail: '\x1b[' }
    const rearmed = new TerminalStreamPosition()
    rearmed.anchor(PTY, 100, '\x1b[')
    expect(rearmed.admit(PTY, '>4;2m', at(100, '>4;2m', cut))).toBe('>4;2m')
    const unsaid = new TerminalStreamPosition()
    unsaid.anchor(PTY, 100)
    expect(unsaid.admit(PTY, '>4;2m', at(100, '>4;2m', cut))).toBe('>4;2m')
  })

  it('treats bytes after its own reset as a gap, even at the same position', () => {
    const position = new TerminalStreamPosition()
    position.anchor(PTY, 100)
    position.invalidate({ grounded: true })
    expect(position.admit(PTY, '2C', at(100, '2C', { startsAtGround: false }))).toBeNull()
  })

  it('starts another PTY fresh, grounding any escape the previous one left open', () => {
    const position = new TerminalStreamPosition()
    position.anchor(PTY, 100)
    expect(position.admit('pty-2', 'hi', at(40, 'hi'))).toBe('\x18hi')
    const replaced = new TerminalStreamPosition()
    replaced.anchor(PTY, 100)
    // Even the new stream's first byte: xterm may still hold the old stream's escape.
    expect(replaced.admit('pty-2', 'hello', at(0, 'hello'))).toBe('\x18hello')
  })

  it("forgets the position when the stream's seq domain ends", () => {
    const position = new TerminalStreamPosition()
    position.anchor(PTY, 1000)
    position.reset(PTY)
    // A revived counter's bytes are not an overlap with the previous incarnation.
    expect(position.admit(PTY, '42B', at(100, '42B', { startsAtGround: false }))).toBeNull()
    position.reset('another-pty')
    expect(position.admit(PTY, 'x', at(0, 'x'))).toBe('\x18x')
  })

  it('releases deliveries with an unknown start after a bounded wait, never known mid-escape ones', () => {
    const position = new TerminalStreamPosition()
    position.anchor(PTY, 0)
    let seq = 10
    const next = (flags: Partial<StreamDelivery>): string | null => {
      const delivery = at(seq, 'plain', { startsAtGround: false, ...flags })
      seq += 'plain'.length
      return position.admit(PTY, 'plain', delivery)
    }
    for (let i = 0; i < 10; i++) {
      expect(next({})).toBeNull()
    }
    for (let i = 0; i < 4; i++) {
      expect(next({ boundaryUnknown: true })).toBeNull()
    }
    expect(next({ boundaryUnknown: true })).toBe('\x18plain')
  })

  it('locates a fresh stream only at its first byte or a proven boundary', () => {
    const position = new TerminalStreamPosition()
    // Attached mid-stream with no replay: a known mid-escape start would print its tail.
    expect(position.admit(PTY, '42B', at(100, '42B', { startsAtGround: false }))).toBeNull()
    // Nothing parsed yet, so xterm is already at ground.
    expect(position.admit(PTY, 'x', at(103, 'x'))).toBe('x')
    const fresh = new TerminalStreamPosition()
    expect(fresh.admit(PTY, '2C', at(0, '2C', { startsAtGround: false }))).toBe('2C')
  })

  it('only trusts an overlap with bytes xterm parsed while it is exactly on the stream', () => {
    const position = new TerminalStreamPosition()
    position.anchor(PTY, 100)
    expect(position.admit(PTY, 'abc', at(98, 'abc', { startsAtGround: false }))).toBe('abc')
    position.invalidate()
    expect(position.admit(PTY, '42B', at(95, '42B', { startsAtGround: false }))).toBeNull()
  })

  it('writes streams without a char-sequence domain as before', () => {
    const position = new TerminalStreamPosition()
    position.invalidate()
    const unlocated = {
      startSeq: undefined,
      endSeq: undefined,
      startsAtGround: true,
      boundaryUnknown: false
    }
    expect(position.admit(PTY, '42B', unlocated)).toBe('42B')
  })

  it('treats an unlocated renderer cut as following lost bytes', () => {
    const position = new TerminalStreamPosition()
    position.anchor(PTY, 0)
    const cut = {
      startSeq: undefined,
      endSeq: undefined,
      startsAtGround: false,
      boundaryUnknown: true
    }
    expect(position.admit(PTY, '42B', cut)).toBeNull()
  })
})

describe('streamDeliveryOf', () => {
  it('locates a whole delivery with main boundary flags', () => {
    expect(
      streamDeliveryOf(
        'abc',
        { data: 'abc', seq: 13, rawLength: 5, midEscape: true },
        { seqCountsChars: true }
      )
    ).toEqual({ startSeq: 8, endSeq: 13, startsAtGround: false, boundaryUnknown: false })
  })

  it('treats a suffix as starting at an unknown boundary', () => {
    expect(streamDeliveryOf('bc', { data: 'abc', seq: 13 }, { seqCountsChars: true })).toEqual({
      startSeq: 11,
      endSeq: 13,
      startsAtGround: false,
      boundaryUnknown: true
    })
  })

  it('reports the escape a cut leaves open where its state is known', () => {
    const cutTail = (delivered: { data: string; seq: number; midEscape?: true | 'unknown' }) =>
      streamDeliveryOf('>4;2m', delivered, { seqCountsChars: true }).cutEscapeTail
    expect(cutTail({ data: 'ab\x1b[>4;2m', seq: 9 })).toBe('\x1b[')
    expect(cutTail({ data: 'ab\x1b[1m>4;2m', seq: 11 })).toBeUndefined()
    // A chunk that starts inside an escape is known from the first ESC it cuts off.
    expect(cutTail({ data: '2B\x1b[>4;2m', seq: 9, midEscape: true })).toBe('\x1b[')
    expect(cutTail({ data: '2B>4;2m', seq: 7, midEscape: 'unknown' })).toBeUndefined()
    // Cut-off bytes holding a C1 control are not scanned.
    expect(cutTail({ data: '\u009bab\x1b[>4;2m', seq: 10 })).toBeUndefined()
  })

  it('never fabricates a position for a suffix of a transformed chunk', () => {
    expect(
      streamDeliveryOf('REST', { data: 'nREST', seq: 130, rawLength: 30 }, { seqCountsChars: true })
    ).toEqual({
      startSeq: undefined,
      endSeq: undefined,
      startsAtGround: false,
      boundaryUnknown: true
    })
  })

  it('cannot locate frame-counted or unsequenced streams', () => {
    expect(
      streamDeliveryOf('abc', { data: 'abc', seq: 3 }, { seqCountsChars: false }).startSeq
    ).toBe(undefined)
    expect(streamDeliveryOf('abc', { data: 'abc' }, { seqCountsChars: true }).startSeq).toBe(
      undefined
    )
  })
})

describe('keptSuffixMeta', () => {
  it('drops the position of a transformed chunk instead of guessing it', () => {
    expect(keptSuffixMeta({ seq: 20, rawLength: 30 }, 10, 4)).toEqual({
      droppedOutput: true,
      midEscape: 'unknown'
    })
  })
})
