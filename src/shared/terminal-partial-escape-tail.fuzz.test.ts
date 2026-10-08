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
// The fold half re-splits every combined stream at every code-unit boundary; the alphabet and
// SEQUENCES deliberately carry CAN/SUB and doubled ESC inside OSC/DCS/SOS/PM/APC, because two
// fold breaks in those exact states shipped undetected while the fold check was only asserted
// on already-normalized pendings (where it is a tautology).

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
  '\x00',
  '\\',
  '[',
  ']',
  'P',
  'X',
  '^',
  '_',
  '(',
  ' ',
  '0',
  ';',
  'm',
  '\n',
  '\x7f',
  '\x9c',
  'é',
  '中',
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
  'ab\x1b[2Jcd',
  // CAN/SUB aborting from inside a string sequence, and from inside its ESC state.
  '\x1b]0;title\x18rest',
  '\x1bPx\x1b\x18X0abc',
  '\x1bP data\x1b\x1arest',
  '\x1b]0;t\x1b\x18\x1b[1m',
  // A second ESC inside OSC/DCS opens its own sequence at that ESC, not at the first one.
  '\x1b] \x1b\x1b^',
  '\x1b]0;t\x1b\x1b\x1b[3',
  '\x1bPq\x1b\x1b]0;x\x07',
  '\x1bX sos \x1b\x1bP'
]

// Yields {text, depth} because an astral symbol is two UTF-16 code units: filtering on
// `text.length` would silently drop every depth-N string containing one, so the corpus would
// not be exhaustive at depth N the way the test names claim.
function* stringsUpTo(maxDepth: number): Generator<{ depth: number; text: string }> {
  yield { depth: 0, text: '' }
  for (let depth = 1; depth <= maxDepth; depth++) {
    const digits = Array.from({ length: depth }, () => 0)
    for (;;) {
      yield { depth, text: digits.map((digit) => ALPHABET[digit]).join('') }
      let place = depth - 1
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
  let foldSplits = 0
  // Why the sweep and not just `advance(extract(pending), chunk)`: every PENDINGS entry is
  // already a tail, so `extract(pending) === pending` makes that form a tautology. Only
  // re-splitting the combined stream lands a boundary inside oscEsc/stringEsc, where the
  // CAN/SUB abort and the second-ESC restart live.
  const checkFolds = (text: string): void => {
    if (text.length > 32) {
      return // keeps the cap corpus (5000-char chunks) out of an O(n^2) sweep
    }
    const whole = extractPartialEscapeTail(text)
    for (let cut = 0; cut <= text.length; cut++) {
      foldSplits++
      const folded = extractPartialEscapeTail(
        extractPartialEscapeTail(text.slice(0, cut)) + text.slice(cut)
      )
      if (folded !== whole) {
        expect.fail(`fold property broke: ${JSON.stringify({ text, cut, whole, folded })}`)
      }
    }
  }
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
    checkFolds(pending + chunk)
  }

  it('matches the unguarded oracle on every chunk up to length 4', () => {
    for (const { text: chunk } of stringsUpTo(3)) {
      for (const pending of PENDINGS) {
        check(pending, chunk)
      }
    }
    for (const { depth, text: chunk } of stringsUpTo(4)) {
      if (depth === 4) {
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
    expect(checked).toBe(963_819)
    expect(foldSplits).toBe(6_236_429)
  })
})
