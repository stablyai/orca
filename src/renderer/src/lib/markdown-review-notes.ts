import type { DiffComment } from '../../../shared/types'
import { getDiffCommentLineLabel } from './diff-comment-compat'

const MAX_EXCERPT_LINES = 8

export type MarkdownReviewNote = DiffComment & { source: 'markdown' }

export function sortMarkdownReviewNotes(
  notes: readonly MarkdownReviewNote[]
): MarkdownReviewNote[] {
  return [...notes].sort((a, b) => {
    const pathCompare = a.filePath.localeCompare(b.filePath)
    if (pathCompare !== 0) {
      return pathCompare
    }
    const startA = a.startLine ?? a.lineNumber
    const startB = b.startLine ?? b.lineNumber
    if (startA !== startB) {
      return startA - startB
    }
    if (a.lineNumber !== b.lineNumber) {
      return a.lineNumber - b.lineNumber
    }
    return a.createdAt - b.createdAt
  })
}

export function getMarkdownReviewExcerpt(
  content: string,
  note: Pick<DiffComment, 'lineNumber' | 'startLine'>
): string {
  const lines = content.split(/\r?\n/)
  const startLine = Math.max(1, note.startLine ?? note.lineNumber)
  const endLine = Math.max(startLine, note.lineNumber)
  const selected = lines.slice(startLine - 1, endLine)
  if (selected.length === 0) {
    return ''
  }

  const excerpt =
    selected.length <= MAX_EXCERPT_LINES
      ? selected
      : [
          ...selected.slice(0, Math.ceil(MAX_EXCERPT_LINES / 2)),
          '...',
          ...selected.slice(selected.length - Math.floor(MAX_EXCERPT_LINES / 2))
        ]

  return excerpt.map((line) => `> ${line}`).join('\n')
}

export function formatMarkdownReviewNotes(
  notes: readonly MarkdownReviewNote[],
  content: string
): string {
  return sortMarkdownReviewNotes(notes)
    .map((note) => {
      const escapedBody = note.body
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
      const excerpt = getMarkdownReviewExcerpt(content, note)
      const parts = [
        `File: ${note.filePath}`,
        'Source: markdown',
        getDiffCommentLineLabel(note),
        excerpt ? `Excerpt:\n${excerpt}` : null,
        `User comment: "${escapedBody}"`
      ]
      return parts.filter((part): part is string => part !== null).join('\n')
    })
    .join('\n\n')
}
