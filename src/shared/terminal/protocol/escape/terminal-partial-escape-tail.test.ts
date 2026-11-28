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

  it.each([
    ['\x1b]t\x9b3', '1', '\x1b[31', 'm'],
    ['\x1b]t\x9d0;', 'hi', '\x1b]0;hi', '\x07'],
    ['\x1b]t\x90q', 'ab', '\x1bPqab', '\x1b\\'],
    ['\x1b]t\x9fG', 'a=1', '\x1b_Ga=1', '\x9c']
  ])(
    'preserves extract(a + b) === extract(extract(a) + b) for C1 opener %j inside an open OSC',
    (first, second, expected, terminator) => {
      const combined = extractPartialEscapeTail(first + second)
      expect(combined).toBe(expected)
      expect(extractPartialEscapeTail(extractPartialEscapeTail(first) + second)).toBe(combined)

      const pending = advancePartialEscapeTail('', first)
      expect(advancePartialEscapeTail(pending, second)).toBe(combined)
      expect(advancePartialEscapeTail(combined, terminator)).toBe('')
    }
  )
})

describe('advancePartialEscapeTail past the length cap', () => {
  it.each([
    ['\x1b]52;c;', '\x07', 'A', '\x1b]x;'],
    ['\x1b]52;c;', '\x9c', 'A', '\x1b]x;'],
    ['\x1bPq', '\x1b\\', '#', '\x1bP0<'],
    ['\x1bPq', '\x9c', '#', '\x1bP0<'],
    ['\x1b_G', '\x18', 'A', '\x1bP0<'],
    ['\x1b_G', '\x9c', 'A', '\x1bP0<'],
    ['\x1b[', 'm', '3', '\x1b[0<'],
    ['\x1b[', '\x9c', '3', '\x1b[0<']
  ])(
    'carries %j as a bounded inert prefix until %j ends it',
    (introducer, terminator, fill, inert) => {
      const overflow = fill.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH)
      expect(advancePartialEscapeTail('', `${introducer}${overflow}${terminator}plain`)).toBe('')
      const tail = advancePartialEscapeTail('', introducer + overflow)
      expect(tail).toBe(inert)
      expect(advancePartialEscapeTail(tail, overflow)).toBe(inert)
      expect(advancePartialEscapeTail(tail, `${fill}${terminator}plain`)).toBe('')
    }
  )
})
