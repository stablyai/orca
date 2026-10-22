import type { MatchRange } from '@/lib/palette-match/normalized-text'

const SNIPPET_MARK = /\[\[([\s\S]*?)\]\]/g

/** The host wraps matched terms in `[[…]]`; returns the plain text and where those terms sit in it. */
export function parseAiVaultSnippetMarks(snippet: string): {
  text: string
  ranges: MatchRange[]
} {
  const ranges: MatchRange[] = []
  let text = ''
  let offset = 0
  for (const match of snippet.matchAll(SNIPPET_MARK)) {
    text += snippet.slice(offset, match.index)
    ranges.push({ start: text.length, end: text.length + match[1].length })
    text += match[1]
    offset = match.index + match[0].length
  }
  return { text: text + snippet.slice(offset), ranges }
}
