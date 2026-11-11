/**
 * A word or phrase dictation should spell `term`'s way, optionally also replacing what the model hears instead.
 * `hint` marks the repo name: it biases recognition and joins its words, but never recases a single word.
 */
export type DictationTerm = { term: string; heardAs?: string; hint?: true }

export const MAX_DICTATION_TERMS = 500
export const MAX_DICTATION_TERM_LENGTH = 100

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

/** Well-formed, distinct entries only, trimmed and capped; undefined when the value isn't a list. */
export function normalizeDictationTerms(value: unknown): DictationTerm[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const terms: DictationTerm[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const term: unknown = entry?.term
    const heardAs: unknown = entry?.heardAs
    if (typeof term !== 'string' || !term.trim()) {
      continue
    }
    const spelling = term.trim().slice(0, MAX_DICTATION_TERM_LENGTH)
    const alias =
      typeof heardAs === 'string' ? heardAs.trim().slice(0, MAX_DICTATION_TERM_LENGTH) : ''
    // The same spelling and alias twice is one stored entry.
    const id = `${spelling}\u0000${alias}`
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    terms.push({
      term: spelling,
      ...(alias ? { heardAs: alias } : {})
    })
  }
  return terms.slice(0, MAX_DICTATION_TERMS)
}

/**
 * The dictionary for a dictation into `repo` (none for a folder workspace): its terms first, so a repo's
 * spelling wins over a personal one, then the personal terms, then its name as a hint unless that's off.
 */
export function dictationTermsFor(
  voice: { dictationTerms?: unknown; dictationRepoNameHint?: boolean } | undefined,
  repo: { dictationTerms?: unknown; displayName?: string } | undefined
): DictationTerm[] {
  const name = repo?.displayName?.trim().slice(0, MAX_DICTATION_TERM_LENGTH)
  return [
    ...(normalizeDictationTerms(repo?.dictationTerms) ?? []),
    ...(normalizeDictationTerms(voice?.dictationTerms) ?? []),
    ...(name && voice?.dictationRepoNameHint !== false ? [{ term: name, hint: true as const }] : [])
  ]
}

type Spelling = { term: string; lead: string; trail: string }

function spelling(term: string): Spelling {
  const [, lead = '', trail = ''] = EDGE_JOINERS_RE.exec(term) ?? []
  return { term, lead, trail }
}

/** Rewrites words that key the same as a term (or its "heard as") to the term's spelling; null when there are none. */
export function createDictationDictionary(
  terms: readonly DictationTerm[] | undefined
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
  for (const { term, hint } of terms ?? []) {
    // A one-word repo name like "orca" would recase every "Orca"; only a name of several words joins.
    if (!hint || (term.match(WORD_RE)?.length ?? 0) > 1) {
      add(wordKey(term), term)
    }
  }
  if (byKey.size === 0 && unspacedAliases.length === 0) {
    return null
  }
  const longestKey = Math.max(0, ...[...byKey.keys()].map((key) => key.length))
  return (text) => {
    for (const [alias, term] of unspacedAliases) {
      text = text.split(alias).join(term)
    }
    return byKey.size > 0 ? replaceWordRuns(text, byKey, longestKey) : text
  }
}

// At each word, the longest run of joined words whose key is a term's becomes that term.
function replaceWordRuns(text: string, byKey: Map<string, Spelling>, longestKey: number): string {
  const words = [...text.matchAll(WORD_RE)].map((word) => ({
    from: word.index,
    to: word.index + word[0].length,
    key: wordKey(word[0])
  }))
  // joinsNext[i]: words i and i + 1 may belong to one term.
  const joinsNext = words.map(
    (word, i) => i + 1 < words.length && JOINING_GAP_RE.test(text.slice(word.to, words[i + 1].from))
  )
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

/** The distinct spellings an engine that takes a context prompt is told to expect. */
export function dictationVocabulary(terms: readonly DictationTerm[] | undefined): string[] {
  return [...new Set((terms ?? []).map((entry) => entry.term))]
}
