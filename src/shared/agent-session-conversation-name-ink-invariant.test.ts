// The invariant behind four rounds of point fixes to this sanitizer, checked by
// machine rather than by a hand-picked list: a name it accepts always contains a
// code point outside the Unicode invisible categories, and never a stray
// surrogate. Narrower than "always draws ink" — a font can still draw nothing for
// a blank-rendering letter such as U+2800 or U+3164, which those categories miss.
//
// Four separate defects here shared one shape — a class of invisible input the
// enumeration of the day happened not to cover. Sweeping the whole invisible
// block removes the guessing.

import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH as MAX,
  normalizeAgentSessionConversationName
} from './agent-session-conversation-name'

const ZWJ = '\u200D'
const ZWNJ = '\u200C'

/** Everything Unicode says is a format, control or space separator. */
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Zs}\p{Zl}\p{Zp}]/u
/** One code point a font can actually draw. */
const INK = /[^\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u
const LONE_SURROGATE = /[\uD800-\uDFFF]/u
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/gu

function invisibleCodePoints(): string[] {
  const out: string[] = []
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) {
      continue
    }
    const ch = String.fromCodePoint(cp)
    if (INVISIBLE.test(ch)) {
      out.push(ch)
    }
  }
  return out
}

const describeCodePoints = (value: string): string =>
  Array.from(
    value,
    (c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
  ).join(' ')

type SweepResult = {
  swept: number
  zeroInk: string[]
  malformed: string[]
}

function sweep(inputs: Iterable<string>): SweepResult {
  const result: SweepResult = { swept: 0, zeroInk: [], malformed: [] }
  for (const input of inputs) {
    result.swept += 1
    const normalized = normalizeAgentSessionConversationName(input)
    if (normalized === null) {
      continue
    }
    if (!INK.test(normalized) && result.zeroInk.length < 5) {
      result.zeroInk.push(
        `in=[${describeCodePoints(input)}] out=[${describeCodePoints(normalized)}]`
      )
    }
    const stray =
      normalized.includes('\uFFFD') || LONE_SURROGATE.test(normalized.replace(SURROGATE_PAIR, ''))
    if (stray && result.malformed.length < 5) {
      result.malformed.push(`in=[${describeCodePoints(input)}]`)
    }
  }
  return result
}

function expectClean(result: SweepResult, atLeast: number): void {
  expect(result.zeroInk).toEqual([])
  expect(result.malformed).toEqual([])
  // Vitest passes a filter that matches nothing; assert the sweep ran.
  expect(result.swept).toBeGreaterThanOrEqual(atLeast)
}

/** Category Cs, so no invisible class reaches them — but a provider that
 *  truncated an emoji sends one, and it draws as U+FFFD. Boundary values only:
 *  the sweeps below are quadratic and the block holds 2048 more. */
const LONE_SURROGATES = ['\uD800', '\uDBFF', '\uDC00', '\uDFFF']

describe('normalizeAgentSessionConversationName never accepts a name that draws no ink', () => {
  const alphabet = [...invisibleCodePoints(), ...LONE_SURROGATES]

  it('covers the joiners it deliberately keeps and the stray surrogates', () => {
    expect(alphabet).toContain(ZWJ)
    expect(alphabet).toContain(ZWNJ)
    expect(alphabet).toEqual(expect.arrayContaining(LONE_SURROGATES))
    expect(alphabet.length).toBeGreaterThan(200)
  })

  it('holds for every invisible code point alone and for every ordered pair', () => {
    function* candidates(): Generator<string> {
      for (const a of alphabet) {
        yield a
        for (const b of alphabet) {
          yield a + b
        }
      }
    }

    expectClean(sweep(candidates()), 60_000)
  })

  it('holds with a joiner interposed at every position of every pair', () => {
    // The defect this closes: a joiner survives the collapsing run, so it breaks
    // the run in two and each half collapses to its own space.
    function* candidates(): Generator<string> {
      for (const joiner of [ZWJ, ZWNJ]) {
        for (const a of alphabet) {
          for (const b of alphabet) {
            yield joiner + a + b
            yield a + joiner + b
            yield a + b + joiner
            yield `${joiner}${a}${joiner}${b}${joiner}`
          }
        }
      }
    }

    expectClean(sweep(candidates()), 500_000)
  })

  it('holds for triples drawn from the invisible code points most seen in the wild', () => {
    const notable = [
      ZWJ,
      ZWNJ,
      ' ',
      '\t',
      '\n',
      '\r',
      '\v',
      '\f',
      '\u0000',
      '\u0007',
      '\u001B',
      '\u0085',
      '\u00A0',
      '\u00AD',
      '\u061C',
      '\u180E',
      '\u2000',
      '\u2028',
      '\u2029',
      '\u200B',
      '\u200E',
      '\u200F',
      '\u202A',
      '\u202B',
      '\u202C',
      '\u202D',
      '\u202E',
      '\u202F',
      '\u205F',
      '\u2060',
      '\u2061',
      '\u2062',
      '\u2063',
      '\u2064',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
      '\u206A',
      '\u206F',
      '\u3000',
      '\uFEFF',
      '\uFFF9',
      '\uFFFB',
      '\u{E0020}',
      '\u{E0041}',
      '\u{E007F}'
    ]

    function* candidates(): Generator<string> {
      for (const a of notable) {
        for (const b of notable) {
          for (const c of notable) {
            yield a + b + c
          }
        }
      }
    }

    expectClean(sweep(candidates()), 100_000)
  })

  it('holds for a seeded random sweep of longer invisible strings', () => {
    const pool = [
      ZWJ,
      ZWNJ,
      ' ',
      '\t',
      '\n',
      '\r',
      '\u00A0',
      '\u3000',
      '\u2028',
      '\u2029',
      '\u202A',
      '\u202E',
      '\u2066',
      '\u2069',
      '\u061C',
      '\u200E',
      '\u200F',
      '\u200B',
      '\uFEFF',
      '\u00AD',
      '\u2060',
      '\u180E',
      '\u{E0020}',
      '\u{E0041}',
      '\u{E007F}',
      'x'
    ]
    let seed = 0x2f6f2b79
    const nextInt = (bound: number): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      seed >>>= 0
      return seed % bound
    }

    function* candidates(): Generator<string> {
      for (let i = 0; i < 100_000; i += 1) {
        let value = ''
        const length = 1 + nextInt(14)
        for (let k = 0; k < length; k += 1) {
          value += pool[nextInt(pool.length)]
        }
        yield value
      }
    }

    expectClean(sweep(candidates()), 100_000)
  })

  it('holds when a blank prefix pushes the only ink past the length cap', () => {
    function* candidates(): Generator<string> {
      for (const filler of [ZWJ, ZWNJ, ' ', `${ZWJ} `, `${ZWNJ}\u2060`]) {
        for (let n = 180; n <= 260; n += 1) {
          for (const ink of ['a', '\u{1F600}', '中']) {
            yield filler.repeat(n) + ink
            yield ink + filler.repeat(n) + ink
          }
        }
      }
    }

    expectClean(sweep(candidates()), 2000)
  })
})

describe('normalizeAgentSessionConversationName keeps legitimate text byte-identical', () => {
  it.each([
    ['family emoji', `Fix \u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467} layout`],
    ['rainbow flag emoji', `Ship \u{1F3F3}\uFE0F${ZWJ}\u{1F308} theme`],
    ['profession emoji', `Add \u{1F469}${ZWJ}\u{1F4BB} avatar`],
    ['Persian ZWNJ', `می${ZWNJ}خواهم تست`],
    ['Hindi ZWNJ conjunct', `क्${ZWNJ}ष ठीक`],
    ['CJK', '修正探针泄漏'],
    ['Arabic', 'إصلاح التحقق'],
    ['Hebrew', 'תיקון הבדיקה'],
    ['combining accents', 'Résumé du fil'],
    ['skin-tone modifier', 'Ship \u{1F44D}\u{1F3FD} review'],
    ['variation selector', 'Ship ❤\uFE0F theme'],
    ['plain ASCII', 'Fix the probe']
  ])('round-trips a %s name', (_label, name) => {
    const normalized = normalizeAgentSessionConversationName(name)

    expect(describeCodePoints(normalized ?? '')).toBe(describeCodePoints(name))
    expect(normalized).toBe(name)
  })

  it('drops a stray surrogate and keeps the astral character beside it', () => {
    const normalized = normalizeAgentSessionConversationName('Fix \uD800probe \u{1F600}\uDFFF')

    // Asserted on code points: the stray halves render as U+FFFD, which is
    // indistinguishable from the real thing in a rendered string.
    expect(describeCodePoints(normalized ?? '')).toBe(
      'U+0046 U+0069 U+0078 U+0020 U+0070 U+0072 U+006F U+0062 U+0065 U+0020 U+1F600'
    )
    expect(LONE_SURROGATE.test((normalized ?? '').replace(SURROGATE_PAIR, ''))).toBe(false)
  })

  it.each(LONE_SURROGATES.map((c) => [describeCodePoints(c), c]))(
    'rejects a name that is only %s',
    (_label, only) => {
      expect(normalizeAgentSessionConversationName(only)).toBeNull()
    }
  )

  it('never strands a joiner when the cut lands inside an emoji sequence', () => {
    const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`

    for (let prefix = 193; prefix <= 201; prefix += 1) {
      const normalized = normalizeAgentSessionConversationName('A'.repeat(prefix) + family)

      expect(normalized).not.toBeNull()
      expect(normalized?.endsWith(ZWJ)).toBe(false)
      expect(normalized?.endsWith(ZWNJ)).toBe(false)
      expect(normalized).not.toContain('\uFFFD')
      expect(LONE_SURROGATE.test((normalized ?? '').replace(SURROGATE_PAIR, ''))).toBe(false)
      expect((normalized ?? '').length).toBeLessThanOrEqual(MAX)
    }
  })
})
