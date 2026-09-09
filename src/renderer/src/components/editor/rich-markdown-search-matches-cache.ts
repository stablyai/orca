import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { TextMatchOptions } from './markdown-preview-search'
import { findRichMarkdownSearchMatches, type RichMarkdownSearchMatch } from './rich-markdown-search'

type CachedMatches = {
  query: string
  matchCase: boolean
  wholeWord: boolean
  matches: RichMarkdownSearchMatch[]
}

export function createRichMarkdownSearchMatchesCache(): typeof findRichMarkdownSearchMatches {
  let previousDoc: ProseMirrorNode | undefined
  let entries: CachedMatches[] = []

  return (doc, query, options: TextMatchOptions = {}, stats) => {
    if (doc !== previousDoc) {
      previousDoc = doc
      entries = []
    }
    const matchCase = options.matchCase ?? false
    const wholeWord = options.wholeWord ?? false
    const existing = entries.find(
      (entry) =>
        entry.query === query && entry.matchCase === matchCase && entry.wholeWord === wholeWord
    )
    if (existing) {
      return existing.matches
    }

    const matches = findRichMarkdownSearchMatches(doc, query, options, stats)
    // The live replacement guard and debounced highlights can have different queries.
    entries = [...entries.slice(-1), { query, matchCase, wholeWord, matches }]
    return matches
  }
}
