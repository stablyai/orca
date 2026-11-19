import { describe, expect, it } from 'vitest'
import {
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH,
  advancePartialEscapeTail,
  advanceTerminalEscapeBoundary,
  extractPartialEscapeTail
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

    const pending = advancePartialEscapeTail('', '\x1bPq\x1b')
    expect(advancePartialEscapeTail(pending, '\x1b[3')).toBe('\x1b[3')
  })
})

describe('advancePartialEscapeTail ESC-free fast path', () => {
  it('still carries a pending tail through an ESC-free chunk', () => {
    expect(advancePartialEscapeTail('\x1b]0;my-title', ' still in the OSC')).toBe(
      '\x1b]0;my-title still in the OSC'
    )
  })
})

describe('advancePartialEscapeTail length cap', () => {
  it('carries a multi-KB OSC 52 copy across the old bound through BEL or split ST', () => {
    const head = `\x1b]52;c;${'A'.repeat(5300)}`
    for (const split of [1, 2, 7, 8, 4095, 4096, 4097, 5306, 5307]) {
      const tail = advancePartialEscapeTail('', head.slice(0, split))
      expect(tail).toBe(head.slice(0, split))
      const continued = advancePartialEscapeTail(tail, head.slice(split))
      expect(continued).toBe(head)
      expect(advancePartialEscapeTail(continued, '\x07plain')).toBe('')
      expect(advancePartialEscapeTail(continued, '\x1b')).toBe('\x1b')
      expect(advancePartialEscapeTail('\x1b', '\\plain')).toBe('')
    }
  })

  it('carries a multi-KB DCS string without dropping its payload', () => {
    const head = `\x1bPq${'B'.repeat(5300)}`
    const tail = advancePartialEscapeTail('', head.slice(0, 4100))
    expect(tail).toBe(head.slice(0, 4100))
    expect(advancePartialEscapeTail(tail, head.slice(4100))).toBe(head)
    expect(advancePartialEscapeTail(head, '\x1b\\plain')).toBe('')
  })

  it('retains the exact cap but makes an oversized OSC inert until termination or abort', () => {
    const atCap = `\x1b]52;c;${'C'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH - 7)}`
    expect(advancePartialEscapeTail('', atCap)).toBe(atCap)
    const tail = advancePartialEscapeTail('', `${atCap}X`)
    expect(tail).toBe('\x1b]x;')
    expect(advancePartialEscapeTail(tail, '0;not-a-title')).toBe('\x1b]x;0;not-a-title')
    expect(advancePartialEscapeTail(tail, '52;c;SGk=\x07plain')).toBe('')
    expect(advancePartialEscapeTail(tail, '\x1b')).toBe('\x1b')
    expect(advancePartialEscapeTail(tail, '\x18plain')).toBe('')
    expect(advancePartialEscapeTail(tail, '\x1aplain')).toBe('')
    expect(advancePartialEscapeTail(tail, '\x1b[3')).toBe('\x1b[3')
    expect(advancePartialEscapeTail('', `${atCap}X\x07plain`)).toBe('')
    expect(advancePartialEscapeTail('', `${atCap}X\x1b`)).toBe('\x1b')
  })

  it('bounds repeated overflow without reinterpreting subsequent OSC payload', () => {
    const tail = advancePartialEscapeTail(
      '',
      `\x1b]52;c;${'D'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH)}`
    )
    expect(tail).toBe('\x1b]x;')
    const continued = advancePartialEscapeTail(tail, '52;c;SGk=')
    expect(continued).toBe('\x1b]x;52;c;SGk=')
    const overflow = advancePartialEscapeTail(continued, 'E'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH))
    expect(overflow).toBe('\x1b]x;')
    expect(advancePartialEscapeTail(overflow, '\x07plain')).toBe('')
  })

  it('uses DCS ignore rather than allowing a new command from an oversized string continuation', () => {
    for (const introducer of ['Pq', 'X', '^', '_']) {
      const tail = advancePartialEscapeTail(
        '',
        `\x1b${introducer}${'E'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH)}`
      )
      expect(tail).toBe('\x1bP0<')
      expect(advancePartialEscapeTail(tail, '$qpayload')).toBe('\x1bP0<$qpayload')
      expect(advancePartialEscapeTail(tail, '\x07')).toBe('\x1bP0<\x07')
      expect(advancePartialEscapeTail(tail, '\x1b\\plain')).toBe('')
      expect(advancePartialEscapeTail(tail, '\x18plain')).toBe('')
      expect(advancePartialEscapeTail(tail, '\x1aplain')).toBe('')
      expect(advancePartialEscapeTail(tail, '\x1b[3')).toBe('\x1b[3')
    }
  })

  it("uses CSI ignore rather than losing an oversized command's parameters", () => {
    const tail = advancePartialEscapeTail('', `\x1b[${'3'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH)}`)
    expect(tail).toBe('\x1b[0<')
    expect(advancePartialEscapeTail(tail, '1;')).toBe('\x1b[0<1;')
    expect(advancePartialEscapeTail(tail, 'Cplain')).toBe('')
    expect(advancePartialEscapeTail(tail, '\x18plain')).toBe('')
    expect(advancePartialEscapeTail(tail, '\x1aplain')).toBe('')
    expect(advancePartialEscapeTail(tail, '\x1b]0;new')).toBe('\x1b]0;new')
  })

  it('keeps an oversized ESC intermediate inert through its final byte', () => {
    const tail = advancePartialEscapeTail('', `\x1b${' '.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH)}`)
    expect(tail).toBe('\x1b!!')
    expect(advancePartialEscapeTail(tail, ' ')).toBe('\x1b!! ')
    expect(advancePartialEscapeTail(tail, 'Fplain')).toBe('')
    expect(advancePartialEscapeTail(tail, '\x18plain')).toBe('')
    expect(advancePartialEscapeTail(tail, '\x1aplain')).toBe('')
    expect(advancePartialEscapeTail(tail, '\x1b[3')).toBe('\x1b[3')
  })

  it('retains a pending ESC after an oversized run of executing C0 controls', () => {
    const tail = advancePartialEscapeTail(
      '',
      `\x1b${'\x00'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH)}`
    )
    expect(tail).toBe('\x1b')
    expect(advancePartialEscapeTail(tail, '[3')).toBe('\x1b[3')
    expect(advancePartialEscapeTail(tail, '\x18plain')).toBe('')
  })
})
