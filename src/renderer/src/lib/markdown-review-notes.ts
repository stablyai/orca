import type { DiffComment } from '../../../shared/types'
import { getDiffCommentLineLabel } from './diff-comment-compat'

const MAX_EXCERPT_LINES = 8
const MAX_CARD_QUOTE_LENGTH = 96

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

export function getMarkdownReviewHighlightedText(
  content: string,
  note: Pick<DiffComment, 'lineNumber' | 'selectedText' | 'startLine'>
): string {
  const selectedText = note.selectedText?.trim()
  if (selectedText) {
    return selectedText
  }
  const excerpt = getMarkdownReviewExcerpt(content, note)
  return excerpt
    .split('\n')
    .map((line) => line.replace(/^> ?/, ''))
    .join('\n')
    .trim()
}

export function formatMarkdownReviewCardQuote(text: string | null | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return undefined
  }
  if (normalized.length <= MAX_CARD_QUOTE_LENGTH) {
    return normalized
  }
  return `${normalized.slice(0, MAX_CARD_QUOTE_LENGTH - 3).trimEnd()}...`
}

export function getMarkdownReviewCardQuote(
  content: string,
  note: Pick<DiffComment, 'lineNumber' | 'selectedText' | 'startLine'>
): string | undefined {
  return formatMarkdownReviewCardQuote(getMarkdownReviewHighlightedText(content, note))
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
      const excerpt = note.selectedText
        ? getMarkdownReviewHighlightedText(content, note)
            .split(/\r\n|\r|\n/)
            .map((line) => `> ${line}`)
            .join('\n')
        : getMarkdownReviewExcerpt(content, note)
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
