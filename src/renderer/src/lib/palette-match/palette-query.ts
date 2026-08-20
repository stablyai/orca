import { isWorktreePaletteQueryTooLarge } from '../worktree-palette-query-bounds'
import { normalizePaletteText } from './normalized-text'

export const PALETTE_QUERY_MAX_TOKENS = 16

const DIGIT = /\p{N}/u
// Why symbols count as content: an emoji is \p{So} and an arrow is \p{Sm}, so a
// letters-and-digits test would classify `🚀` as punctuation and drop the token —
// and the palette input expands `:rocket:` into exactly that.
const ALPHANUMERIC = /[\p{L}\p{N}\p{S}\p{Extended_Pictographic}]/u
const LETTERS_ONLY = /^\p{L}+$/u
const LATIN_OR_DIGIT = /^[\p{Script=Latin}\p{Nd}]$/u
const IDENTIFIER_PUNCTUATION = /[./#!_-]/

export type PaletteQueryToken = {
  index: number
  text: string
  /** Maximal alphanumeric runs, e.g. `08/13` -> ['08','13']. */
  components: string[]
  /** Components joined, e.g. `1.4.182` -> `14182`. */
  compact: string
  /** Digit-bearing or identifier-punctuated tokens never fuzzy-match. */
  isIdentifierLike: boolean
  isLetterOnly: boolean
  isPunctuationOnly: boolean
  /** A lone Latin letter/digit may only equal or prefix a word. */
  isSingleLatinCharacter: boolean
  repoBranch: { repo: string; branch: string } | null
}

export type PreparedPaletteQuery =
  | { state: 'empty' }
  | { state: 'invalid'; reason: 'too-large' | 'too-many-tokens' }
  | { state: 'ready'; normalized: string; tokens: readonly PaletteQueryToken[] }

function splitComponents(text: string): string[] {
  const components: string[] = []
  let current = ''
  for (const character of text) {
    if (ALPHANUMERIC.test(character)) {
      current += character
    } else if (current) {
      components.push(current)
      current = ''
    }
  }
  if (current) {
    components.push(current)
  }
  return components
}

function parseRepoBranch(text: string): { repo: string; branch: string } | null {
  const slashIndex = text.indexOf('/')
  if (slashIndex <= 0 || slashIndex >= text.length - 1) {
    return null
  }
  return { repo: text.slice(0, slashIndex), branch: text.slice(slashIndex + 1) }
}

export function createPaletteQueryToken(text: string, index: number): PaletteQueryToken {
  const components = splitComponents(text)
  const characters = [...text]
  return {
    index,
    text,
    components,
    compact: components.join(''),
    isIdentifierLike: DIGIT.test(text) || IDENTIFIER_PUNCTUATION.test(text),
    isLetterOnly: LETTERS_ONLY.test(text),
    isPunctuationOnly: !ALPHANUMERIC.test(text),
    isSingleLatinCharacter: characters.length === 1 && LATIN_OR_DIGIT.test(text),
    repoBranch: parseRepoBranch(text)
  }
}

/**
 * Folds the query once per keystroke and splits it on whitespace only —
 * punctuation stays inside tokens so `08-13` and `orca/main` survive intact.
 */
export function preparePaletteQuery(query: string): PreparedPaletteQuery {
  if (isWorktreePaletteQueryTooLarge(query)) {
    return { state: 'invalid', reason: 'too-large' }
  }
  // Why collapse runs: field text is always single-spaced, so an uncollapsed double
  // space can never satisfy the whole-query equality/prefix tier and the exact-name
  // match silently loses its rank. Safe here — this string feeds only scoreWholeQuery
  // and carries no offset mapping back into the source text.
  const normalized = normalizePaletteText(query).normalized.replace(/ +/g, ' ').trim()
  if (!normalized) {
    return { state: 'empty' }
  }

  const seen = new Set<string>()
  const tokens: PaletteQueryToken[] = []
  for (const raw of normalized.split(' ')) {
    if (!raw || seen.has(raw)) {
      continue
    }
    seen.add(raw)
    tokens.push(createPaletteQueryToken(raw, tokens.length))
  }

  if (!tokens.length) {
    return { state: 'empty' }
  }
  if (tokens.length > PALETTE_QUERY_MAX_TOKENS) {
    return { state: 'invalid', reason: 'too-many-tokens' }
  }
  return { state: 'ready', normalized, tokens }
}

export function isLetterOnlyWord(word: string): boolean {
  return LETTERS_ONLY.test(word)
}
