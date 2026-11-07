import { describe, expect, it } from 'vitest'
import {
  keptSuffixMeta,
  markedAfterEviction,
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

  it('grounds an escape xterm holds when resuming at a proven boundary after a gap', () => {
    const position = new TerminalStreamPosition()
    position.admit(PTY, 'a\x1b[3', at(0, 'a\x1b[3'))
    expect(position.admit(PTY, 'done', at(40, 'done'))).toBe('\x18done')
  })

  it('lets a replay anchor the stream so its pending escape tail is completed', () => {
    const position = new TerminalStreamPosition()
    position.admit(PTY, 'x', at(0, 'x'))
    position.anchor(PTY, 100)
    expect(position.admit(PTY, '2Bdone', at(100, '2Bdone', { startsAtGround: false }))).toBe(
      '2Bdone'
    )
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

  it("writes a brand-new pane's first byte without grounding", () => {
    expect(new TerminalStreamPosition().admit(PTY, 'hello', at(0, 'hello'))).toBe('hello')
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

  it('needs no CAN when its own reset already grounded xterm', () => {
    const position = new TerminalStreamPosition()
    position.anchor(PTY, 100)
    position.invalidate({ grounded: true })
    expect(position.admit(PTY, 'next', at(120, 'next'))).toBe('next')
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
  it('maps a kept tail onto its true raw range', () => {
    expect(keptSuffixMeta({ seq: 20, rawLength: 10 }, 10, 4)).toEqual({
      seq: 20,
      rawLength: 4,
      droppedOutput: true,
      midEscape: 'unknown'
    })
  })

  it('drops the position of a transformed chunk instead of guessing it', () => {
    expect(keptSuffixMeta({ seq: 20, rawLength: 30 }, 10, 4)).toEqual({
      droppedOutput: true,
      midEscape: 'unknown'
    })
  })
})

describe('markedAfterEviction', () => {
  it("marks kept app bytes as following a gap but leaves main's drop sentinel as recovery bytes", () => {
    expect(markedAfterEviction({ seq: 9 })).toEqual({
      seq: 9,
      droppedOutput: true,
      midEscape: 'unknown'
    })
    expect(markedAfterEviction({ droppedOutput: true })).toEqual({ droppedOutput: true })
  })
})
