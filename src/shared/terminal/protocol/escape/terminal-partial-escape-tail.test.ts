import { describe, expect, it } from 'vitest'
import {
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH,
  advancePartialEscapeTail,
  advanceTerminalEscapeBoundary,
  extractPartialEscapeTail
} from './terminal-partial-escape-tail'

describe('advanceTerminalEscapeBoundary', () => {
  it.each(['\x1b]0;title', '\x1bPqpayload'])(
    'retains only the pending ESC after a string ends: %j',
    (prefix) => {
      const stream = `${prefix}\x1b`
      expect(extractPartialEscapeTail(stream)).toBe('\x1b')
      expect(advanceTerminalEscapeBoundary('', stream)).toBe('\x1b')
      for (let split = 0; split <= stream.length; split += 1) {
        const state = advanceTerminalEscapeBoundary('', stream.slice(0, split))
        const continued = advanceTerminalEscapeBoundary(state, stream.slice(split))
        expect(continued).toBe('\x1b')
      }
      for (const completion of ['\\', '[31m', '\x1b[0m', '\x18', '\x1a', ']0;next\x07']) {
        expect(advanceTerminalEscapeBoundary('\x1b', completion)).toBe('')
        expect(extractPartialEscapeTail(stream + completion)).toBe('')
      }
    }
  )
})

describe('extractPartialEscapeTail', () => {
  it('treats a fresh ESC as aborting a pending CSI', () => {
    expect(extractPartialEscapeTail('\x1b[3\x1b[0m')).toBe('')
    expect(extractPartialEscapeTail('\x1b[3\x1b[')).toBe('\x1b[')
  })

  it('treats CAN/SUB as aborting an in-progress escape back to ground', () => {
    // CAN/SUB abort every VT500 parser state, including ESC/intermediate states.
    expect(extractPartialEscapeTail('\x1b\x18')).toBe('') // ESC CAN
    expect(extractPartialEscapeTail('\x1b\x1a')).toBe('') // ESC SUB
    expect(extractPartialEscapeTail('\x1b \x18')).toBe('') // ESC SP CAN
    expect(extractPartialEscapeTail('\x1b#\x1a')).toBe('') // ESC # SUB
    expect(extractPartialEscapeTail('\x1b[38;\x18')).toBe('') // CSI ... CAN
    expect(extractPartialEscapeTail('\x1b]0;title\x18')).toBe('') // OSC ... CAN
    // A CAN that aborts, followed by a fresh dangling sequence, tracks the new one:
    expect(extractPartialEscapeTail('\x1b\x18\x1b[3')).toBe('\x1b[3')
  })

  it('aborts to ground on CAN/SUB inside a string sequence', () => {
    // CAN/SUB in stringEsc must abort, not become an ESC suffix; that bogus tail broke fold equivalence.
    expect(extractPartialEscapeTail('\x1bPx\x1b\x18X0abc')).toBe('')
    expect(extractPartialEscapeTail('\x1bPx\x1b\x1aX0abc')).toBe('')
    // Same state reached through OSC (oscEsc).
    expect(extractPartialEscapeTail('\x1b]0;t\x1b\x18rest')).toBe('')
    // A fresh sequence after the abort is still tracked.
    expect(extractPartialEscapeTail('\x1bPx\x1b\x18\x1b[3')).toBe('\x1b[3')
  })

  it('starts the new sequence at the second ESC inside OSC/DCS', () => {
    // The second ESC owns the new sequence; starting one byte earlier breaks fold equivalence.
    expect(extractPartialEscapeTail('\x1b] \x1b\x1b^')).toBe('\x1b^')
    expect(extractPartialEscapeTail('\x1bPq\x1b\x1b[3')).toBe('\x1b[3')
    expect(extractPartialEscapeTail('\x1b]0;t\x1b\x1b')).toBe('\x1b')

    const pending = advancePartialEscapeTail('', '\x1bPq\x1b')
    expect(advancePartialEscapeTail(pending, '\x1b[3')).toBe('\x1b[3')
  })

  it('tracks split ST, CAN/SUB, and ESC aborts across Kitty APC chunks identically to unsplit input', () => {
    const kittyBurst =
      '\x1b_Ga=T,f=100;AAAA\x1b\\\x1b_Gm=1;BBBB\x1b\x1b[31mok\x1b_Gm=0;CCCC\x18next\x1b_Gopen\x1b'
    expect(extractPartialEscapeTail(kittyBurst)).toBe('\x1b')

    let tail = ''
    for (let i = 0; i < kittyBurst.length; i += 3) {
      tail = advancePartialEscapeTail(tail, kittyBurst.slice(i, i + 3))
    }
    expect(tail).toBe('\x1b')
    expect(advancePartialEscapeTail(tail, '\\done')).toBe('')
  })

  it('handles OSC BEL/ST, un-aborted string fast path, and CAN/SUB string aborts consistently', () => {
    const stream =
      '\x1b_Ga=T,m=1;PAYLOAD1\x1b\\\x1b]0;title-bel\x07\x1b]2;title-st\x1b\\\x1b_Gm=0;PAYLOAD2\x1b\\\x1b]52;open'
    expect(extractPartialEscapeTail(stream)).toBe('\x1b]52;open')
    let state = ''
    for (let i = 0; i < stream.length; i += 7) {
      state = advanceTerminalEscapeBoundary(state, stream.slice(i, i + 7))
    }
    expect(state).toBe('\x1b]')
    expect(advanceTerminalEscapeBoundary(state, 'rest\x07after')).toBe('')
    expect(advanceTerminalEscapeBoundary('\x1bP', 'abc\x1b\\next')).toBe('')
    expect(advanceTerminalEscapeBoundary('\x1bP', 'abc\x18next\x1b[3')).toBe('\x1b[')
  })
})

describe('advancePartialEscapeTail past the length cap', () => {
  it.each([
    ['\x1b]52;c;', 'A', '\x1b]x;', '\x07'],
    ['\x1bPq', '#', '\x1bP0<', '\x1b\\'],
    ['\x1b_G', 'A', '\x1bP0<', '\x18'],
    ['\x1b[', '3', '\x1b[0<', 'm']
  ])(
    'carries %j as a bounded inert prefix until it ends',
    (introducer, fill, inert, terminator) => {
      const overflow = fill.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH)
      const tail = advancePartialEscapeTail('', introducer + overflow)
      expect(tail).toBe(inert)
      expect(advancePartialEscapeTail(tail, overflow)).toBe(inert)
      expect(advancePartialEscapeTail(tail, `${fill}${terminator}plain`)).toBe('')
    }
  )
})
