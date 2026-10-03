/**
 * Staleness gate for the frozen tables in terminal-emoji-width-ranges.ts.
 *
 * The bug those tables fix is a width table that stopped tracking Unicode.
 * A frozen table can acquire that same bug silently, so this re-derives all
 * three from the runtime's own Unicode data and xterm's Unicode 11 provider —
 * the recipe recorded in the module header — and compares. Nothing here reads
 * the committed ranges to build its expectation.
 *
 * Direction matters, because the tables are frozen at one Unicode version and
 * this runs on whatever the test runner embeds — CI and a developer machine do
 * not always agree, so nothing load-bearing may depend on the version matching:
 *  - "no missing entries" catches staleness, the direction the tables exist to
 *    prevent. It runs always: an older runtime has simply not assigned the
 *    newest code points, so it cannot fail this direction spuriously.
 *  - "no spurious entries" catches a hand-edited or mis-generated table. It
 *    runs always too, allowing only entries this runtime has not assigned —
 *    which is exactly how a genuinely newer table looks to an older runtime,
 *    and is not how a wrong entry looks, since a wrong one names something the
 *    runtime already knows.
 *  - exact equality is the strictest form and needs both sides on the same
 *    Unicode version, so it runs only when they match.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import {
  EMOJI_MODIFIER_BASE_RANGES,
  EMOJI_PRESENTATION_WIDE_RANGES,
  EMOJI_VARIATION_BASE_RANGES,
  isEmojiModifierBase,
  isEmojiPresentationWideCodepoint,
  isEmojiVariationSequenceBase,
  type CodepointRange
} from './terminal-emoji-width-ranges'

/** The version the header records the tables as generated against. */
const GENERATED_AGAINST_UNICODE = '17.0'

const LAST_CODEPOINT = 0x10ffff
const SURROGATE_FIRST = 0xd800
const SURROGATE_LAST = 0xdfff
const REGIONAL_INDICATOR_FIRST = 0x1f1e6
const REGIONAL_INDICATOR_LAST = 0x1f1ff

const EMOJI = /\p{Emoji}/u
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const EMOJI_MODIFIER_BASE = /\p{Emoji_Modifier_Base}/u
/** Unassigned to THIS runtime — how a newer table's entries look to an older one. */
const UNASSIGNED = /\p{Cn}/u

type UnicodeServiceInternals = { activeVersion: string; wcwidth(codepoint: number): number }

function openUnicode11(): { terminal: Terminal; unicode: UnicodeServiceInternals } {
  const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  const unicode = (terminal as unknown as { _core: { unicodeService: UnicodeServiceInternals } })
    ._core.unicodeService
  unicode.activeVersion = '11'
  return { terminal, unicode }
}

/** Re-derives the three sets straight from the recipe in the module header. */
function deriveTables(unicode: UnicodeServiceInternals): {
  wide: number[]
  variationBase: number[]
  modifierBase: number[]
} {
  const wide: number[] = []
  const variationBase: number[] = []
  const modifierBase: number[] = []
  for (let codepoint = 0; codepoint <= LAST_CODEPOINT; codepoint += 1) {
    if (codepoint >= SURROGATE_FIRST && codepoint <= SURROGATE_LAST) {
      continue
    }
    const char = String.fromCodePoint(codepoint)
    if (EMOJI_MODIFIER_BASE.test(char)) {
      modifierBase.push(codepoint)
    }
    if (!EMOJI.test(char)) {
      continue
    }
    if (EMOJI_PRESENTATION.test(char)) {
      const isRegionalIndicator =
        codepoint >= REGIONAL_INDICATOR_FIRST && codepoint <= REGIONAL_INDICATOR_LAST
      if (unicode.wcwidth(codepoint) !== 2 && !isRegionalIndicator) {
        wide.push(codepoint)
      }
    } else if (unicode.wcwidth(codepoint) === 1) {
      variationBase.push(codepoint)
    }
  }
  return { wide, variationBase, modifierBase }
}

function expandRanges(ranges: readonly CodepointRange[]): number[] {
  const codepoints: number[] = []
  for (const [first, last] of ranges) {
    for (let codepoint = first; codepoint <= last; codepoint += 1) {
      codepoints.push(codepoint)
    }
  }
  return codepoints
}

const hex = (value: number): string => `U+${value.toString(16).toUpperCase().padStart(4, '0')}`

/** Contiguous code points collapse into one entry so a drift reads as ranges. */
function summarize(codepoints: number[]): string[] {
  const runs: [number, number][] = []
  for (const codepoint of codepoints) {
    const last = runs.at(-1)
    if (last && last[1] === codepoint - 1) {
      last[1] = codepoint
      continue
    }
    runs.push([codepoint, codepoint])
  }
  return runs.map(([first, last]) => (first === last ? hex(first) : `${hex(first)}..${hex(last)}`))
}

const TABLES: [string, readonly CodepointRange[], (codepoint: number) => boolean][] = [
  ['emoji presentation wide', EMOJI_PRESENTATION_WIDE_RANGES, isEmojiPresentationWideCodepoint],
  ['emoji variation base', EMOJI_VARIATION_BASE_RANGES, isEmojiVariationSequenceBase],
  ['emoji modifier base', EMOJI_MODIFIER_BASE_RANGES, isEmojiModifierBase]
]

describe('emoji width range derivation', () => {
  const { terminal, unicode } = openUnicode11()
  const derived = deriveTables(unicode)
  const derivedByName: Record<string, number[]> = {
    'emoji presentation wide': derived.wide,
    'emoji variation base': derived.variationBase,
    'emoji modifier base': derived.modifierBase
  }
  terminal.dispose()

  it.each(TABLES)('%s: the committed table holds every derived code point', (name, ranges) => {
    const committed = new Set(expandRanges(ranges))
    const missing = derivedByName[name]!.filter((codepoint) => !committed.has(codepoint))
    expect(summarize(missing)).toEqual([])
  })

  it.each(TABLES)('%s: the lookup agrees with the committed ranges', (_name, ranges, lookup) => {
    // Guards the binary search and the fast-path bound, not just the data.
    const disagreeing = expandRanges(ranges).filter((codepoint) => !lookup(codepoint))
    expect(summarize(disagreeing)).toEqual([])
    expect(lookup(SURROGATE_FIRST)).toBe(false)
  })

  it.each(TABLES)('%s: the committed table holds no spurious code point', (name, ranges) => {
    // Why the unassigned allowance rather than a version guard: an entry this
    // runtime has never heard of is what a table generated against a newer
    // Unicode legitimately looks like here. An entry the runtime DOES know, and
    // still does not derive, is a wrong entry on any version.
    const derivedSet = new Set(derivedByName[name]!)
    const spurious = expandRanges(ranges).filter(
      (codepoint) => !derivedSet.has(codepoint) && !UNASSIGNED.test(String.fromCodePoint(codepoint))
    )
    expect(summarize(spurious)).toEqual([])
  })

  it.each(TABLES)('%s: matches the derivation exactly on the generated version', (name, ranges) => {
    if (process.versions.unicode !== GENERATED_AGAINST_UNICODE) {
      // A different embedded Unicode version legitimately derives a different
      // set. The two cases above still run there and between them cover both
      // directions, so skipping this one costs strictness, not coverage.
      expect(process.versions.unicode).toBeTypeOf('string')
      return
    }
    expect(summarize(expandRanges(ranges))).toEqual(summarize(derivedByName[name]!))
  })

  it('excludes regional indicators so a flag stays two cells', () => {
    for (
      let codepoint = REGIONAL_INDICATOR_FIRST;
      codepoint <= REGIONAL_INDICATOR_LAST;
      codepoint += 1
    ) {
      expect(isEmojiPresentationWideCodepoint(codepoint)).toBe(false)
    }
  })
})
