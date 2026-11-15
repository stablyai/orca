import type { DictationTerm } from './dictation-dictionary'
import { createNearMissMatcher, type NearMissMatcher } from './dictation-near-miss'

// Symbols that belong to a name ("C#", "C++", "@orca") count as part of a word, so a term never doubles them.
const WORD_RE = /[\p{L}\p{M}\p{N}#+@$&]+/gu
// Spaces, or one joiner as in "on-change" or "stt-worker.ts": what may sit between the words of one term.
const JOINING_GAP_RE = /^(?:\s+|[-_./])$/u
// A term's own leading or trailing joiners, as in ".NET", taken along when the text already has them.
const EDGE_JOINERS_RE = /^([-_./]*)[\s\S]*?([-_./]*)$/u
// Scripts written without spaces, where a phrase can only be found inside a longer run of letters.
const UNSPACED_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
const MAX_WORDS_PER_TERM = 8

// "Use Audio Capture", "use-audio-capture" and "useAudioCapture" all key as "useaudiocapture".
function wordKey(text: string): string {
  return (text.normalize('NFKC').toLowerCase().match(WORD_RE) ?? []).join('')
}

type Spelling = { term: string; lead: string; trail: string }

function spelling(term: string): Spelling {
  const [, lead = '', trail = ''] = EDGE_JOINERS_RE.exec(term) ?? []
  return { term, lead, trail }
}

/**
 * Rewrites words that key the same as a term (or its "heard as") to the term's spelling, then, in English
 * text (`languages` includes "en", or the text reads as English when they are unknown), single words that are
 * near misses of a long, uncommon term ("Superbase" for "Supabase"); null when there are no terms.
 */
export function createDictationDictionary(
  terms: readonly DictationTerm[] | undefined,
  languages?: readonly string[]
): ((text: string) => string) | null {
  const byKey = new Map<string, Spelling>()
  const unspacedAliases: [heardAs: string, term: string][] = []
  const add = (key: string, term: string): void => {
    if (key && !byKey.has(key)) {
      byKey.set(key, spelling(term))
    }
  }
  // A "heard as" is what the user asked for, so it beats another term spelled the same.
  for (const { term, heardAs } of terms ?? []) {
    if (heardAs && UNSPACED_SCRIPT_RE.test(heardAs)) {
      unspacedAliases.push([heardAs, term])
    } else if (heardAs) {
      add(wordKey(heardAs), term)
    }
  }
  // The repo name is a guess, not something the user typed, so it never takes a near miss.
  const typedTerms: [key: string, spelling: Spelling][] = []
  for (const { term, hint } of terms ?? []) {
    // A one-word repo name like "orca" would recase every "Orca"; only a name of several words joins.
    if (!hint || (term.match(WORD_RE)?.length ?? 0) > 1) {
      add(wordKey(term), term)
    }
    if (!hint) {
      typedTerms.push([wordKey(term), spelling(term)])
    }
  }
  if (byKey.size === 0 && unspacedAliases.length === 0) {
    return null
  }
  const nearMiss = createNearMissMatcher(typedTerms, languages)
  const longestKey = Math.max(0, ...[...byKey.keys()].map((key) => key.length))
  return (text) => {
    for (const [alias, term] of unspacedAliases) {
      text = text.split(alias).join(term)
    }
    return byKey.size > 0 ? replaceWordRuns(text, byKey, longestKey, nearMiss) : text
  }
}

// At each word, the longest run of joined words whose key is a term's becomes that term; failing
// that, the word alone when it is a near miss of one.
function replaceWordRuns(
  text: string,
  byKey: Map<string, Spelling>,
  longestKey: number,
  nearMiss: NearMissMatcher<Spelling> | null
): string {
  const words = [...text.matchAll(WORD_RE)].map((word) => ({
    from: word.index,
    to: word.index + word[0].length,
    key: wordKey(word[0])
  }))
  // joinsNext[i]: words i and i + 1 may belong to one term.
  const joinsNext = words.map(
    (word, i) => i + 1 < words.length && JOINING_GAP_RE.test(text.slice(word.to, words[i + 1].from))
  )
  const nearMisses = nearMiss?.(words.map((word) => word.key)) ?? null
  let out = ''
  let cursor = 0
  for (let start = 0; start < words.length;) {
    let key = ''
    let match: { end: number; spelling: Spelling } | null = null
    for (let end = start; end < words.length && end - start < MAX_WORDS_PER_TERM; end++) {
      if (end > start && !joinsNext[end - 1]) {
        break
      }
      key += words[end].key
      if (key.length > longestKey) {
        break
      }
      const found = byKey.get(key)
      if (found) {
        match = { end, spelling: found }
      }
    }
    // Only a single word: in ordinary speech, words run together sound like terms ("is to" and "Istio").
    const nearMissOf = match ? undefined : nearMisses?.[start]
    if (nearMissOf) {
      match = { end: start, spelling: nearMissOf }
    }
    if (!match) {
      start++
      continue
    }
    const { term, lead, trail } = match.spelling
    let from = words[start].from
    let to = words[match.end].to
    if (lead && from - lead.length >= cursor && text.slice(from - lead.length, from) === lead) {
      from -= lead.length
    }
    if (trail && text.startsWith(trail, to)) {
      to += trail.length
    }
    out += text.slice(cursor, from) + term
    cursor = to
    start = match.end + 1
  }
  return out + text.slice(cursor)
}
