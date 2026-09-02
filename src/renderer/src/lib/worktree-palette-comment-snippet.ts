import type { MatchRange } from './worktree-palette-search'

export function extractWorktreePaletteCommentSnippet(
  comment: string,
  matchStart: number,
  matchEnd: number
): { text: string; matchRange: MatchRange } {
  let snippetStart = Math.max(0, matchStart - 40)
  let snippetEnd = Math.min(comment.length, matchEnd + 40)

  for (let i = 0; i < 10 && snippetStart > 0; i++) {
    if (/\s/.test(comment[snippetStart - 1])) {
      break
    }
    snippetStart--
  }
  for (let i = 0; i < 10 && snippetEnd < comment.length; i++) {
    if (/\s/.test(comment[snippetEnd])) {
      break
    }
    snippetEnd++
  }

  // Why: the offsets above count UTF-16 code units and the boundary loops test one unit at
  // a time, so either edge can land between the halves of a surrogate pair \u2014 CJK text backs
  // up the full 10 iterations without ever finding whitespace. Snap outward to keep the pair
  // whole; matchRange derives from snippetStart, so widening by one keeps it correct.
  if (snippetStart > 0 && (comment.charCodeAt(snippetStart) & 0xfc00) === 0xdc00) {
    snippetStart -= 1
  }
  if (snippetEnd < comment.length && (comment.charCodeAt(snippetEnd - 1) & 0xfc00) === 0xd800) {
    snippetEnd += 1
  }

  const prefix = snippetStart > 0 ? '\u2026' : ''
  const suffix = snippetEnd < comment.length ? '\u2026' : ''
  return {
    text: `${prefix}${comment.slice(snippetStart, snippetEnd)}${suffix}`,
    matchRange: {
      start: prefix.length + matchStart - snippetStart,
      end: prefix.length + matchEnd - snippetStart
    }
  }
}
