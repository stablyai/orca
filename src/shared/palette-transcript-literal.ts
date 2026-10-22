import { splitAiVaultSearchQuery } from './ai-vault-search-query-operators'
import {
  mapNormalizedRange,
  normalizePaletteText,
  type MatchRange
} from './palette-normalized-text'

export type PaletteTranscriptSourceBoundaries = {
  startsMessage?: boolean
  endsMessage?: boolean
}

export type PaletteTranscriptOccurrence = MatchRange & { group: number }

function sourceSupportedBoundary(
  text: string,
  offset: number,
  edge: 'start' | 'end',
  boundaries: PaletteTranscriptSourceBoundaries
): boolean {
  if (offset === 0) {
    return edge === 'start' && boundaries.startsMessage === true
  }
  if (offset === text.length) {
    return edge === 'end' && boundaries.endsMessage === true
  }
  if (offset < 0 || offset > text.length || /[\uDC00-\uDFFF]/u.test(text[offset])) {
    return false
  }
  const here = String.fromCodePoint(text.codePointAt(offset) ?? 0)
  if (/\p{M}/u.test(here)) {
    return false
  }
  let end = offset
  let before = ''
  while (end > 0) {
    let start = end - 1
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) {
      start--
    }
    before = text.slice(start, end)
    end = start
    if (!/\p{M}/u.test(before)) {
      break
    }
    if (end === 0) {
      return false
    }
  }
  if (/[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(here)) {
    return (
      /\p{N}/u.test(before) !== /\p{N}/u.test(here) ||
      (/\p{Lu}/u.test(here) && !/\p{Lu}/u.test(before))
    )
  }
  return edge === 'start'
    ? /[\p{L}\p{N}]/u.test(here) || /\s/u.test(before)
    : /[\p{L}\p{N}]/u.test(before) || /\s/u.test(here)
}

function foldWhitespace(text: string): { text: string; offsets: number[] | null } {
  if (!text.includes('  ')) {
    return { text, offsets: null }
  }
  let folded = ''
  const offsets: number[] = []
  for (let index = 0; index < text.length; index++) {
    if (text[index] === ' ' && folded.endsWith(' ')) {
      continue
    }
    folded += text[index]
    offsets.push(index)
  }
  return { text: folded, offsets }
}

/** No backend caps, stop-word removal, or spelling repair participates in literal proof. */
export function preparePaletteTranscriptProofQuery(query: string): readonly string[] {
  const freeText = splitAiVaultSearchQuery(query).text
  const requirements = new Set<string>()
  let at = 0
  while (at < freeText.length) {
    if (/\s/u.test(freeText[at])) {
      at++
      continue
    }
    const quote = freeText[at]
    const close = quote === '"' || quote === "'" ? freeText.indexOf(quote, at + 1) : -1
    const quoted = close >= 0
    const end = quoted ? close + 1 : at + (freeText.slice(at).match(/^\S+/u)?.[0].length ?? 1)
    const value = quoted ? freeText.slice(at + 1, close) : freeText.slice(at, end)
    const text = normalizePaletteText(value).normalized.replace(/ +/g, ' ').trim()
    for (const token of text.split(' ')) {
      if (token) {
        requirements.add(token)
      }
    }
    if (quoted && text) {
      requirements.add(text)
    }
    at = end
  }
  return [...requirements]
}

/** Source-supported word, identifier and quoted-phrase anchors, in original offsets. */
export function paletteTranscriptLiteralOccurrences(
  text: string,
  requirements: readonly string[],
  boundaries: PaletteTranscriptSourceBoundaries = {}
): PaletteTranscriptOccurrence[] {
  const normalized = normalizePaletteText(text)
  const collapsed = foldWhitespace(normalized.normalized)
  const occurrences: PaletteTranscriptOccurrence[] = []
  for (const [group, requirement] of requirements.entries()) {
    let at = 0
    while (at < collapsed.text.length) {
      const start = collapsed.text.indexOf(requirement, at)
      if (start === -1) {
        break
      }
      const end = start + requirement.length
      const normalizedStart = collapsed.offsets?.[start] ?? start
      const normalizedEnd = (collapsed.offsets?.[end - 1] ?? end - 1) + 1
      const range = mapNormalizedRange(normalized, normalizedStart, normalizedEnd)
      const wholeFold =
        (!normalized.starts ||
          normalizedStart === 0 ||
          normalized.starts[normalizedStart] !== normalized.starts[normalizedStart - 1]) &&
        (!normalized.ends ||
          normalizedEnd === normalized.normalized.length ||
          normalized.ends[normalizedEnd - 1] !== normalized.ends[normalizedEnd])
      if (
        wholeFold &&
        sourceSupportedBoundary(text, range.start, 'start', boundaries) &&
        sourceSupportedBoundary(text, range.end, 'end', boundaries)
      ) {
        occurrences.push({ ...range, group })
      }
      at = start + 1
    }
  }
  return occurrences
}
