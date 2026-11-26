import { sanitizeRepoMonogramText } from './repo-icon'

// Words that say nothing about which project this is, so they never supply a letter.
const FILLER_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'rb',
  'rs',
  'io',
  'com',
  'org',
  'net',
  'dev',
  'git'
])

function nameWords(displayName: string): string[] {
  const words = displayName
    // Split camelCase and letter/digit boundaries so `myApp2` reads as my / App / 2.
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, '$1$3 $2$4')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const meaningful = words.filter((word) => !FILLER_WORDS.has(word.toLowerCase()))
  // A name made only of filler (e.g. `dev`) still needs letters.
  return meaningful.length > 0 ? meaningful : words
}

const isConsonant = (character: string): boolean =>
  /\p{L}/u.test(character) && !/[AEIOUY]/.test(character)

/**
 * Pick the letters a person would: initials for multi-word names, the first two letters for one
 * word, then other letters from the name so it differs from letters other projects already show.
 */
export function suggestRepoMonogram(displayName: string, taken: Iterable<string> = []): string {
  const used = new Set(Array.from(taken, (text) => text.toUpperCase()))
  const words = nameWords(displayName)
  if (words.length === 0) {
    return '?'
  }
  const [first, ...rest] = words.map((word) => Array.from(word.toUpperCase()))
  const lead = first[0]
  const later = first.slice(1)
  const candidates = [
    ...(rest.length > 0 ? rest.map((word) => lead + word[0]) : []),
    lead + (later[0] ?? ''),
    // Consonants carry a word's shape (`orca` → OR, OC), so they beat vowels as fallbacks.
    ...later.filter(isConsonant).map((character) => lead + character),
    ...later.map((character) => lead + character),
    ...rest.map((word) => word[0] + (word[1] ?? '')),
    lead
  ]
  const valid = candidates
    .map((candidate) => sanitizeRepoMonogramText(candidate))
    .filter((candidate): candidate is string => candidate !== null)
  return valid.find((candidate) => !used.has(candidate)) ?? valid[0] ?? '?'
}

// Approximate semibold advance widths (em) for the app font, so wide pairs like `WW` can shrink
// to fit while narrow ones like `OI` stay large. Anything unlisted (digits, CJK) uses a default.
const GLYPH_WIDTHS_EM: Record<string, number> = {
  I: 0.3,
  J: 0.52,
  L: 0.56,
  F: 0.58,
  E: 0.6,
  T: 0.62,
  Z: 0.62,
  S: 0.63,
  P: 0.64,
  Y: 0.64,
  B: 0.66,
  R: 0.66,
  X: 0.66,
  K: 0.67,
  V: 0.67,
  A: 0.68,
  C: 0.7,
  D: 0.72,
  U: 0.72,
  G: 0.73,
  H: 0.73,
  N: 0.74,
  O: 0.76,
  Q: 0.76,
  M: 0.86,
  W: 0.96
}
const DIGIT_WIDTH_EM = 0.62
const OTHER_WIDTH_EM = 1

export function monogramWidthEm(text: string): number {
  return Array.from(text.toUpperCase()).reduce(
    (total, character) =>
      total +
      (GLYPH_WIDTHS_EM[character] ?? (/\p{N}/u.test(character) ? DIGIT_WIDTH_EM : OTHER_WIDTH_EM)),
    0
  )
}

// Letters fill this much of the mark's height, unless that would be too wide for its width.
const MONOGRAM_HEIGHT_FILL = { one: 0.72, two: 0.8 }
const MONOGRAM_WIDTH_FILL = 0.8

/** Font size as a fraction of the mark's side, sized so every pair fits inside the tile. */
export function monogramFontScale(text: string): number {
  const heightFill =
    Array.from(text).length > 1 ? MONOGRAM_HEIGHT_FILL.two : MONOGRAM_HEIGHT_FILL.one
  return Math.min(heightFill, MONOGRAM_WIDTH_FILL / Math.max(monogramWidthEm(text), 0.01))
}
