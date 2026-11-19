import { sanitizeRepoMonogramText } from './repo-icon'

function nameWords(displayName: string): string[] {
  return (
    displayName
      // Split camelCase and digit runs so `myApp2` reads as my / App / 2.
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  )
}

/**
 * Pick 1–2 letters for a project the way people abbreviate it: initials for multi-word names,
 * the first letter for single words, then longer fallbacks so it differs from letters in use.
 */
export function suggestRepoMonogram(displayName: string, taken: Iterable<string> = []): string {
  const used = new Set(Array.from(taken, (text) => text.toUpperCase()))
  const words = nameWords(displayName)
  if (words.length === 0) {
    return '?'
  }
  const [first, ...rest] = words.map((word) => Array.from(word.toUpperCase()))
  const lead = first[0]
  const candidates = [
    rest.length > 0 ? lead + rest[0][0] : lead,
    lead + (first[1] ?? ''),
    ...rest.map((word) => lead + word[0]),
    ...first.slice(2).map((character) => lead + character),
    lead
  ]
  const valid = candidates
    .map((candidate) => sanitizeRepoMonogramText(candidate))
    .filter((candidate): candidate is string => candidate !== null)
  return valid.find((candidate) => !used.has(candidate)) ?? valid[0] ?? '?'
}
