import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'

export function normalizeDiffComment(comment: DiffComment): DiffComment {
  const rawSource = (comment as { source?: unknown }).source
  const source = rawSource === 'markdown' || rawSource === 'diff' ? rawSource : undefined
  const rawStartLine = (comment as { startLine?: unknown }).startLine
  const startLine =
    Number.isInteger(rawStartLine) &&
    typeof rawStartLine === 'number' &&
    rawStartLine >= 1 &&
    rawStartLine <= comment.lineNumber
      ? rawStartLine
      : undefined
  const rawSelectedText = (comment as { selectedText?: unknown }).selectedText
  const selectedText =
    typeof rawSelectedText === 'string' && rawSelectedText.trim().length > 0
      ? rawSelectedText.trim()
      : undefined
  const rawSentAt = (comment as { sentAt?: unknown }).sentAt
  const sentAt =
    typeof rawSentAt === 'number' && Number.isFinite(rawSentAt) && rawSentAt > 0
      ? rawSentAt
      : undefined

  return {
    ...comment,
    ...(source !== undefined ? { source } : {}),
    ...(source === undefined ? { source: undefined } : {}),
    ...(selectedText !== undefined ? { selectedText } : {}),
    ...(selectedText === undefined ? { selectedText: undefined } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(startLine === undefined ? { startLine: undefined } : {}),
    ...(sentAt !== undefined ? { sentAt } : {}),
    ...(sentAt === undefined ? { sentAt: undefined } : {})
  }
}
