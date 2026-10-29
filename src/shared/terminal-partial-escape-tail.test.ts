import { describe, expect, it } from 'vitest'
import {
  advancePartialEscapeTail,
  advanceTerminalEscapeBoundary,
  extractPartialEscapeTail,
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH
} from './terminal-partial-escape-tail'

describe('advanceTerminalEscapeBoundary', () => {
  it.each(['\x1b]0;title', '\x1bPqpayload', '\x1bXsos', '\x1b^pm', '\x1b_apc'])(
    'retains only the pending ESC after a string ends: %j',
    (prefix) => {
      const stream = `${prefix}\x1b`
      expect(extractPartialEscapeTail(stream)).toBe('\x1b')
      expect(advanceTerminalEscapeBoundary('', stream)).toBe('\x1b')
      for (let split = 0; split <= stream.length; split += 1) {
        const state = advanceTerminalEscapeBoundary('', stream.slice(0, split))
        const continued = advanceTerminalEscapeBoundary(state, stream.slice(split))
        expect(continued).toBe('\x1b')
        for (const completion of ['\\', '[31m', '\x1b[0m', '\x18', '\x1a', ']0;next\x07']) {
          expect(advanceTerminalEscapeBoundary(continued, completion)).toBe('')
          expect(extractPartialEscapeTail(stream + completion)).toBe('')
        }
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
  })
})

describe('advancePartialEscapeTail', () => {
  it('abandons tracking (returns empty) past the cap', () => {
    // An unterminated OSC longer than the cap degrades to pre-fix behavior.
    const huge = `\x1b]0;${'x'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH + 10)}`
    expect(advancePartialEscapeTail('', huge)).toBe('')
  })
})

describe('advancePartialEscapeTail ESC-free fast path', () => {
  it('still carries a pending tail through an ESC-free chunk', () => {
    expect(advancePartialEscapeTail('\x1b]0;my-title', ' still in the OSC')).toBe(
      '\x1b]0;my-title still in the OSC'
    )
  })
})
