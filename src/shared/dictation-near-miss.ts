import { levenshtein } from './edit-distance'

// Shorter terms sit too close to ordinary words ("Vite" and "vote", "Hono" and "honey").
const MIN_TERM_KEY_LENGTH = 5
const LATIN_LETTERS_RE = /^[a-z]+$/

// The list is ~850 KB, so only a dictionary with a term to near-miss loads it; until then nothing near-misses.
let commonWords: ReadonlySet<string> | undefined
let commonWordsLoad: Promise<void> | undefined
function loadCommonWords(): void {
  commonWordsLoad ??= import('./dictation-english-words.js').then(
    ({ COMMON_ENGLISH_WORDS }) => {
      commonWords = new Set(COMMON_ENGLISH_WORDS.split(' '))
    },
    () => {
      commonWordsLoad = undefined
    }
  )
}

/**
 * Roughly how a lowercase a-z key sounds: its consonants and where its vowels fall, after the spellings
 * English writes one sound several ways ("ph", "c", "x") and the "r" non-rhotic accents drop ("super" as "supa").
 */
function soundKey(key: string): string {
  return key
    .replace(/ph/g, 'f')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/(?<=[aeiouy])r(?![aeiouy])/g, '')
    .replace(/[aeiouy]+/g, 'a')
    .replace(/(.)\1+/g, '$1')
}

type NearMissTerm<T> = { key: string; consonants: number; term: T }

/** For a text's word keys, the term each word is a near miss of, or null when none is or it may not be English. */
export type NearMissMatcher<T> = (keys: readonly string[]) => (T | undefined)[] | null

/**
 * Matches near misses of `terms` (by word key) in text in `languages`, or in text that reads as English when
 * they are unknown; null when no term is long enough or the language is known not to be English.
 */
export function createNearMissMatcher<T>(
  terms: readonly (readonly [key: string, term: T])[],
  languages: readonly string[] | undefined
): NearMissMatcher<T> | null {
  const bySound = new Map<string, NearMissTerm<T>[]>()
  for (const [key, term] of terms) {
    if (key.length >= MIN_TERM_KEY_LENGTH && LATIN_LETTERS_RE.test(key)) {
      const sound = soundKey(key)
      const consonants = sound.replaceAll('a', '').length
      bySound.set(sound, [...(bySound.get(sound) ?? []), { key, consonants, term }])
    }
  }
  if (bySound.size === 0 || (languages && !languages.includes('en'))) {
    return null
  }
  loadCommonWords()
  const match = (key: string, words: ReadonlySet<string>): T | undefined => {
    // An ordinary word or name is never a misheard term.
    if (!LATIN_LETTERS_RE.test(key) || words.has(key)) {
      return undefined
    }
    let best: { term: T; distance: number } | undefined
    for (const candidate of bySound.get(soundKey(key)) ?? []) {
      // A term that is itself a word ("Drizzle") is heard right, so what sounds like it is another word.
      if (words.has(candidate.key)) {
        continue
      }
      // Sounding the same and spelled close ("Versal" for "Vercel"), with fewer edits than the consonants
      // that agree, since a term of few consonants ("Sonar") sounds like many words ("Sonner").
      const distance = levenshtein(key, candidate.key)
      const allowed = Math.min(
        Math.floor(Math.max(key.length, candidate.key.length) / 3),
        candidate.consonants - 1
      )
      if (distance <= allowed && (!best || distance < best.distance)) {
        best = { term: candidate.term, distance }
      }
    }
    return best?.term
  }
  return (keys) => {
    const words = commonWords
    const found = words ? keys.map((key) => match(key, words)) : []
    if (!words || !found.some(Boolean)) {
      return null
    }
    if (languages) {
      return found
    }
    // Short words ("I", "a") and the misheard words say little about the language; two thirds of the rest must
    // be English, since other languages share a few words with it ("den", "part").
    const rest = keys.filter((key, index) => key.length > 2 && !found[index])
    const english = rest.filter((key) => words.has(key)).length
    return rest.length > 0 && english * 3 >= rest.length * 2 ? found : null
  }
}
