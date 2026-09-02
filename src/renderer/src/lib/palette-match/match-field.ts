import { mapNormalizedRange, type MatchRange } from './normalized-text'
import {
  identifierKindAllowsPrefix,
  paletteProfileAllowedQualities,
  type PaletteIndexedField
} from './indexed-field'
import { isLetterOnlyWord, type PaletteQueryToken } from './palette-query'
import type { PaletteMatchQuality } from './match-quality'
import type { PaletteAtom } from './text-segments'
import { isPaletteTypoCandidate, isWithinOnePaletteEdit } from './typo-distance'

export type PaletteFieldMatch = {
  quality: PaletteMatchQuality
  ranges: readonly MatchRange[]
}

const SHORT_TOKEN_QUALITIES: ReadonlySet<PaletteMatchQuality> = new Set<PaletteMatchQuality>([
  'field-exact',
  'word-exact',
  'field-prefix',
  'word-prefix'
])

const PREFIX_QUALITIES: ReadonlySet<PaletteMatchQuality> = new Set<PaletteMatchQuality>([
  'field-prefix',
  'word-prefix'
])

const MIN_COMPACT_LENGTH = 2
const SIGILS = new Set(['#', '!'])

function allowedQualities(
  field: PaletteIndexedField,
  token: PaletteQueryToken
): ReadonlySet<PaletteMatchQuality> {
  let qualities = paletteProfileAllowedQualities(field.profile)
  if (field.identifier && !identifierKindAllowsPrefix(field.identifier.kind)) {
    qualities = qualities.filter((quality) => !PREFIX_QUALITIES.has(quality))
  }
  if (token.isSingleLatinCharacter) {
    qualities = qualities.filter((quality) => SHORT_TOKEN_QUALITIES.has(quality))
  }
  if (token.isIdentifierLike) {
    qualities = qualities.filter((quality) => quality !== 'typo')
  }
  return new Set(qualities)
}

/** `#123` must not reach a GitLab MR, and `!123` must not reach a GitHub PR. */
function passesSigilGate(field: PaletteIndexedField, token: PaletteQueryToken): boolean {
  const leading = token.text[0]
  if (!SIGILS.has(leading)) {
    return true
  }
  return field.identifier ? field.identifier.sigil === leading : true
}

function isWordStart(field: PaletteIndexedField, index: number): boolean {
  return field.words.some((word) => word.start === index) || index === 0
}

function matchAtomComponentRun(atom: PaletteAtom, compact: string): [number, number] | null {
  const components = atom.components
  for (let start = 0; start < components.length; start += 1) {
    let joined = ''
    for (let end = start; end < components.length; end += 1) {
      joined += components[end].text
      if (joined.length > compact.length) {
        break
      }
      if (joined === compact) {
        return [components[start].start, components[end].end]
      }
    }
  }
  return null
}

function toRanges(field: PaletteIndexedField, start: number, end: number): readonly MatchRange[] {
  return [mapNormalizedRange(field.text, start, end)]
}

function matchLiteral(
  field: PaletteIndexedField,
  token: PaletteQueryToken,
  qualities: ReadonlySet<PaletteMatchQuality>
): PaletteFieldMatch | null {
  const normalized = field.text.normalized
  const text = token.text

  if (qualities.has('field-exact') && normalized === text) {
    return { quality: 'field-exact', ranges: toRanges(field, 0, normalized.length) }
  }
  if (qualities.has('word-exact')) {
    const word = field.words.find((entry) => entry.text === text)
    if (word) {
      return { quality: 'word-exact', ranges: toRanges(field, word.start, word.end) }
    }
    const atom = field.atoms.find((entry) => normalized.slice(entry.start, entry.end) === text)
    if (atom) {
      return { quality: 'word-exact', ranges: toRanges(field, atom.start, atom.end) }
    }
  }
  if (qualities.has('field-prefix') && normalized.startsWith(text)) {
    return { quality: 'field-prefix', ranges: toRanges(field, 0, text.length) }
  }
  if (qualities.has('word-prefix')) {
    const word = field.words.find((entry) => entry.text.startsWith(text))
    const atom = field.atoms.find((entry) => normalized.startsWith(text, entry.start))
    const start = word && atom ? Math.min(word.start, atom.start) : (word?.start ?? atom?.start)
    if (start !== undefined) {
      return { quality: 'word-prefix', ranges: toRanges(field, start, start + text.length) }
    }
  }

  const literalIndex = normalized.indexOf(text)
  if (literalIndex === -1) {
    return null
  }
  if (qualities.has('boundary-substring') && isWordStart(field, literalIndex)) {
    return {
      quality: 'boundary-substring',
      ranges: toRanges(field, literalIndex, literalIndex + text.length)
    }
  }
  if (qualities.has('literal-substring')) {
    return {
      quality: 'literal-substring',
      ranges: toRanges(field, literalIndex, literalIndex + text.length)
    }
  }
  return null
}

function matchCompact(
  field: PaletteIndexedField,
  token: PaletteQueryToken,
  qualities: ReadonlySet<PaletteMatchQuality>
): PaletteFieldMatch | null {
  if (!qualities.has('compact') || token.compact.length < MIN_COMPACT_LENGTH) {
    return null
  }
  for (const atom of field.atoms) {
    const run = matchAtomComponentRun(atom, token.compact)
    if (run) {
      return { quality: 'compact', ranges: toRanges(field, run[0], run[1]) }
    }
  }
  return null
}

function matchTypo(
  field: PaletteIndexedField,
  token: PaletteQueryToken,
  qualities: ReadonlySet<PaletteMatchQuality>
): PaletteFieldMatch | null {
  if (!qualities.has('typo') || !token.isLetterOnly || !isPaletteTypoCandidate(token.text)) {
    return null
  }
  for (const word of field.words) {
    if (!isPaletteTypoCandidate(word.text) || !isLetterOnlyWord(word.text)) {
      continue
    }
    if (isWithinOnePaletteEdit(token.text, word.text)) {
      return { quality: 'typo', ranges: toRanges(field, word.start, word.end) }
    }
  }
  return null
}

/** Best allowed match of one token against one field, or null when unmatched. */
export function matchPaletteField(
  field: PaletteIndexedField,
  token: PaletteQueryToken
): PaletteFieldMatch | null {
  if (token.isPunctuationOnly || !passesSigilGate(field, token)) {
    return null
  }
  const qualities = allowedQualities(field, token)
  return (
    matchLiteral(field, token, qualities) ??
    matchCompact(field, token, qualities) ??
    matchTypo(field, token, qualities)
  )
}
