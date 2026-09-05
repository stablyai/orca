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
    // OSC 0 title with no BEL/ST terminator yet.
    expect(extractPartialEscapeTail('\x1b]0;my-title')).toBe('\x1b]0;my-title')
    // Terminated OSC is clean.
    expect(extractPartialEscapeTail('\x1b]0;title\x07after')).toBe('')
    expect(extractPartialEscapeTail('\x1b]0;title\x1b\\after')).toBe('')
  })

  it('treats a fresh ESC as aborting a pending CSI', () => {
    // The second ESC starts a new (complete) sequence.
    expect(extractPartialEscapeTail('\x1b[3\x1b[0m')).toBe('')
    // ...and a new dangling one.
    expect(extractPartialEscapeTail('\x1b[3\x1b[')).toBe('\x1b[')
  })

  it('treats CAN/SUB as aborting an in-progress escape back to ground', () => {
    // CAN (0x18) / SUB (0x1a) abort the sequence in xterm's VT500 parser.
    // esc state:
    expect(extractPartialEscapeTail('\x1b\x18')).toBe('') // ESC CAN
    expect(extractPartialEscapeTail('\x1b\x1a')).toBe('') // ESC SUB
    // escIntermediate state (ESC then an intermediate byte, then CAN):
    expect(extractPartialEscapeTail('\x1b \x18')).toBe('') // ESC SP CAN
    expect(extractPartialEscapeTail('\x1b#\x1a')).toBe('') // ESC # SUB
    // csi/osc/string already aborted — keep them green:
    expect(extractPartialEscapeTail('\x1b[38;\x18')).toBe('') // CSI ... CAN
    expect(extractPartialEscapeTail('\x1b]0;title\x18')).toBe('') // OSC ... CAN
    // A CAN that aborts, followed by a fresh dangling sequence, tracks the new one:
    expect(extractPartialEscapeTail('\x1b\x18\x1b[3')).toBe('\x1b[3')
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
      ['\x1b ', '\x18after']
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
  // The gate must be indistinguishable from the walk it skips: `extractPartialEscapeTail` only
  // leaves `ground` on an ESC byte, so a chunk with none can only produce ''.
  const pieces = [
    '',
    'plain output\n',
    '\u001b[32mgreen\u001b[0m',
    '\u001b[3',
    '\u001b]0;title\u0007',
    '\u001b]0;partial',
    '\u001bP dcs payload',
    '\u001b',
    '\u0018',
    '\u001a',
    '\u001b]8;;https://example.com\u001b\\',
    '\u001b(',
    'no escapes at all',
    '\u001b[1;2;3'
  ]

  it('matches an unconditional fold for every pending-tail and chunk pairing', () => {
    for (const pending of pieces) {
      const seedTail = extractPartialEscapeTail(pending)
      for (const chunk of pieces) {
        const unconditional = extractPartialEscapeTail(seedTail + chunk)
        expect({
          pending: seedTail,
          chunk,
          tail: advancePartialEscapeTail(seedTail, chunk)
        }).toEqual({
          pending: seedTail,
          chunk,
          tail: unconditional.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : unconditional
        })
      }
    }
  })

  it('still carries a pending tail through an ESC-free chunk', () => {
    const pending = '\u001b]0;my-title'
    const chunk = ' still inside the OSC payload'
    expect(advancePartialEscapeTail(pending, chunk)).toBe(pending + chunk)
  })
})
