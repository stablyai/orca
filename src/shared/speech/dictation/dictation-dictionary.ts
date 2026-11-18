/**
 * A word or phrase dictation should spell `term`'s way, optionally also replacing what the model hears instead.
 * `hint` marks the repo name: it biases recognition and joins its words, but never recases a single word.
 */
export type DictationTerm = { term: string; heardAs?: string; hint?: true }

export const MAX_DICTATION_TERMS = 500
export const MAX_DICTATION_TERM_LENGTH = 100

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

/** The distinct spellings an engine that takes a context prompt is told to expect. */
export function dictationVocabulary(terms: readonly DictationTerm[] | undefined): string[] {
  return [...new Set((terms ?? []).map((entry) => entry.term))]
}
