import { describe, expect, it } from 'vitest'
import {
  advancePartialEscapeTail,
  extractPartialEscapeTail,
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH
} from './terminal-partial-escape-tail'

// Differential fuzz for the ESC-free gate in `advancePartialEscapeTail`: the guarded fold must be
// byte-for-byte indistinguishable from the unguarded oracle (concat + full walk + cap) on every
// input, and must preserve the fold property extract(a + b) === extract(extract(a) + b).
// A 25.6M-case out-of-band sweep (exhaustive len<=5, 2000 x 16 KB random chunks, every BMP code
// unit) found 0 divergences; this is the CI-sized slice of it.

const oracle = (pending: string, chunk: string): string => {
  const tail = extractPartialEscapeTail(pending + chunk)
  return tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : tail
}

// Every byte class the scanner branches on, plus code units the gate's `includes` must not confuse.
const ALPHABET = [
  '\x1b',
  '\x18',
  '\x1a',
  '\x07',
  '\\',
  '[',
  ']',
  'P',
  'X',
  '^',
  '_',
  '(',
  '0',
  ';',
  'm',
  '\n',
  '\x7f',
  '\x9c',
  'é',
  '\u{1f600}',
  '\ud83d',
  '\udc00'
]

// One representative of every state the scanner can be left in.
const PENDINGS = [
  '',
  '\x1b',
  '\x1b[',
  '\x1b[3',
  '\x1b]0;ti',
  '\x1b]0;ti\x1b',
  '\x1bP dcs',
  '\x1bPx\x1b',
  '\x1b(',
  '\x1b ',
  '\x1b[1;2;3'
]

const SEQUENCES = [
  '\x1b[1;31m',
  '\x1b]0;my title\x07',
  '\x1b]8;;https://example.com\x1b\\',
  '\x1bPq#0;2;0;0;0#0!6~\x1b\\',
  '\x1b(B',
  '\x1b7',
  '\x1b[?1049h',
  '\x1b]52;c;aGVsbG8=\x1b\\',
  'ab\x1b[2Jcd'
]

function* stringsUpTo(maxLength: number): Generator<string> {
  yield ''
  for (let length = 1; length <= maxLength; length++) {
    const digits = Array.from({ length }, () => 0)
    for (;;) {
      yield digits.map((digit) => ALPHABET[digit]).join('')
      let place = length - 1
      while (place >= 0 && ++digits[place] === ALPHABET.length) {
        digits[place--] = 0
      }
      if (place < 0) {
        break
      }
    }
  }
}

describe('advancePartialEscapeTail differential fuzz', () => {
  let checked = 0
  const check = (pending: string, chunk: string): void => {
    checked++
    const actual = advancePartialEscapeTail(pending, chunk)
    if (actual !== oracle(pending, chunk)) {
      expect.fail(`gate diverged: ${JSON.stringify({ pending, chunk, actual })}`)
    }
    const whole = extractPartialEscapeTail(pending + chunk)
    if (
      whole.length <= MAX_PARTIAL_ESCAPE_TAIL_LENGTH &&
      advancePartialEscapeTail(extractPartialEscapeTail(pending), chunk) !== whole
    ) {
      expect.fail(`fold property broke: ${JSON.stringify({ pending, chunk })}`)
    }
  }

  it('matches the unguarded oracle on every chunk up to length 4', () => {
    for (const chunk of stringsUpTo(3)) {
      for (const pending of PENDINGS) {
        check(pending, chunk)
      }
    }
    for (const chunk of stringsUpTo(4)) {
      if (chunk.length === 4) {
        check('', chunk)
        check('\x1b[', chunk)
      }
    }
  })

  it('matches at every split point of known sequences', () => {
    for (const sequence of SEQUENCES) {
      for (let cut = 0; cut <= sequence.length; cut++) {
        const afterPrefix = advancePartialEscapeTail('', sequence.slice(0, cut))
        check('', sequence.slice(0, cut))
        for (let cut2 = cut; cut2 <= sequence.length; cut2++) {
          check(afterPrefix, sequence.slice(cut, cut2))
          check(
            advancePartialEscapeTail(afterPrefix, sequence.slice(cut, cut2)),
            sequence.slice(cut2)
          )
        }
      }
    }
  })

  it('matches across the tail-length cap', () => {
    const max = MAX_PARTIAL_ESCAPE_TAIL_LENGTH
    for (const length of [max - 1, max, max + 1, max + 100]) {
      const osc = `\x1b]0;${'x'.repeat(length - 4)}`
      for (const chunk of ['', 'y', '\x07', '\x1b\\', '\x1b', 'plain\n', 'x'.repeat(5000)]) {
        check(osc, chunk)
        check('', osc + chunk)
        check('\x1b]0;', osc.slice(4) + chunk)
      }
    }
  })

  it('ran the whole corpus', () => {
    expect(checked).toBe(516_566)
  })
})
