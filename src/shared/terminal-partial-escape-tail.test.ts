import { describe, expect, it } from 'vitest'
import {
  advancePartialEscapeTail,
  extractPartialEscapeTail,
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH
} from './terminal-partial-escape-tail'

describe('extractPartialEscapeTail', () => {
  it('returns empty for parser-clean streams', () => {
    expect(extractPartialEscapeTail('')).toBe('')
    expect(extractPartialEscapeTail('plain text no escapes')).toBe('')
    expect(extractPartialEscapeTail('\x1b[38;5;196mred\x1b[0m done')).toBe('')
    expect(extractPartialEscapeTail('\x1b[2J\x1b[H')).toBe('')
  })

  it('returns the dangling CSI when a chunk ends mid-sequence', () => {
    expect(extractPartialEscapeTail('hello\x1b[3')).toBe('\x1b[3')
    expect(extractPartialEscapeTail('a\x1b[38;5;')).toBe('\x1b[38;5;')
    expect(extractPartialEscapeTail('\x1b')).toBe('\x1b')
    expect(extractPartialEscapeTail('\x1b[')).toBe('\x1b[')
  })

  it('returns the dangling OSC (unterminated) sequence', () => {
    expect(extractPartialEscapeTail('\x1b]0;my-title')).toBe('\x1b]0;my-title')
    expect(extractPartialEscapeTail('\x1b]0;title\x07after')).toBe('')
    expect(extractPartialEscapeTail('\x1b]0;title\x1b\\after')).toBe('')
  })

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

  it('is fold-safe across chunk boundaries', () => {
    // extract(a + b) === extract(extract(a) + b) — the invariant ingest relies on.
    const cases: [string, string][] = [
      ['first\x1b[3', '8;5;196mred'],
      ['\x1b', '[0m'],
      ['\x1b]0;ti', 'tle\x07'],
      ['clean', '\x1b[1'],
      // Fold-safety must hold across the CAN abort too.
      ['\x1b', '\x18after'],
      ['\x1b ', '\x18after'],
      // Boundary landing inside stringEsc/oscEsc — the two states that used to break the fold.
      ['\x1bPx\x1b\x18', 'X0abc'],
      ['\x1b]0;t\x1b\x1a', 'X0abc'],
      ['\x1b] \x1b\x1b', '^'],
      ['\x1bPq\x1b\x1b', '[3']
    ]
    for (const [a, b] of cases) {
      expect(extractPartialEscapeTail(extractPartialEscapeTail(a) + b)).toBe(
        extractPartialEscapeTail(a + b)
      )
    }
  })
})

describe('advancePartialEscapeTail', () => {
  it('accumulates a split sequence across chunks', () => {
    let tail = ''
    tail = advancePartialEscapeTail(tail, 'ls\r\n\x1b[3')
    expect(tail).toBe('\x1b[3')
    tail = advancePartialEscapeTail(tail, '8;5;196m')
    expect(tail).toBe('') // sequence completed
  })

  it('abandons tracking (returns empty) past the cap', () => {
    // An unterminated OSC longer than the cap degrades to pre-fix behavior.
    const huge = `\x1b]0;${'x'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH + 10)}`
    expect(advancePartialEscapeTail('', huge)).toBe('')
  })
})

describe('advancePartialEscapeTail ESC-free fast path', () => {
  // Compare every pending-state/chunk pairing against the unconditional fold.
  const pieces = [
    '',
    'plain output\n',
    '\x1b[32mgreen\x1b[0m',
    '\x1b[3',
    '\x1b]0;title\x07',
    '\x1b]0;partial',
    '\x1bP dcs payload',
    '\x1b',
    '\x18',
    '\x1a',
    '\x1b]8;;https://example.com\x1b\\',
    '\x1b(',
    '\x1b[1;2;3'
  ]

  it('matches an unconditional fold for every pending-tail and chunk pairing', () => {
    for (const pending of pieces.map((piece) => extractPartialEscapeTail(piece))) {
      for (const chunk of pieces) {
        // Apply the cap to the oracle too or large pairings compare different contracts.
        const unguarded = extractPartialEscapeTail(pending + chunk)
        expect(advancePartialEscapeTail(pending, chunk), JSON.stringify({ pending, chunk })).toBe(
          unguarded.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : unguarded
        )
      }
    }
  })

  it('still carries a pending tail through an ESC-free chunk', () => {
    expect(advancePartialEscapeTail('\x1b]0;my-title', ' still in the OSC')).toBe(
      '\x1b]0;my-title still in the OSC'
    )
  })
})
