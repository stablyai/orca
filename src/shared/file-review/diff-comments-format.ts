import type { DiffComment } from './diff-comment-types'

function isMarkdownComment(comment: Pick<DiffComment, 'source'>): boolean {
  return comment.source === 'markdown'
}

// Keep the pasted review-note contract deterministic and quote-safe across clients/agents.
export function formatDiffComment(c: DiffComment): string {
  const escaped = c.body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  const locationLabel =
    c.lineNumber === 0
      ? 'Scope: file'
      : c.startLine !== undefined && c.startLine !== c.lineNumber
        ? `Lines: ${c.startLine}-${c.lineNumber}`
        : `Line: ${c.lineNumber}`
  if (!isMarkdownComment(c)) {
    return [`File: ${c.filePath}`, locationLabel, `User comment: "${escaped}"`].join('\n')
  }
  // Line numbers go stale once the file is edited; the text the note was left on still locates it.
  const excerpt = c.selectedText?.trim()
  return [
    `File: ${c.filePath}`,
    'Source: markdown',
    locationLabel,
    ...(excerpt ? [`Excerpt:\n${quoteMarkdownNoteExcerpt(excerpt)}`] : []),
    `User comment: "${escaped}"`
  ].join('\n')
}

export function quoteMarkdownNoteExcerpt(text: string): string {
  return `> ${text.replace(/\r\n|\r|\n/g, '\n> ')}`
}

export function formatDiffComments(comments: readonly DiffComment[]): string {
  return comments.map(formatDiffComment).join('\n\n')
}
