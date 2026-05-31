import type { DiffComment } from './types'

function isMarkdownComment(comment: Pick<DiffComment, 'source'>): boolean {
  return comment.source === 'markdown'
}

// Why: the pasted format is the contract between review notes and whichever
// agent consumes them. Keep it deterministic and quote-safe across clients.
export function formatDiffComment(c: DiffComment): string {
  const escaped = c.body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  const lineLabel =
    c.startLine !== undefined && c.startLine !== c.lineNumber
      ? `Lines: ${c.startLine}-${c.lineNumber}`
      : `Line: ${c.lineNumber}`
  if (!isMarkdownComment(c)) {
    return [`File: ${c.filePath}`, lineLabel, `User comment: "${escaped}"`].join('\n')
  }
  return [`File: ${c.filePath}`, 'Source: markdown', lineLabel, `User comment: "${escaped}"`].join(
    '\n'
  )
}

export function formatDiffComments(comments: readonly DiffComment[]): string {
  return comments.map(formatDiffComment).join('\n\n')
}
