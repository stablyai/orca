import type { DiffComment } from '../../../shared/types'
import { isMarkdownComment } from './diff-comment-compat'

// Why: the pasted format is the contract between this feature and whatever
// agent consumes it. Keep it stable and deterministic — quote escaping matters
// because the body is surfaced inside literal quotes. Escape backslashes
// first so that `\"` in user input does not decay into an unescaped quote.
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

export function formatDiffComments(comments: DiffComment[]): string {
  return comments.map(formatDiffComment).join('\n\n')
}
