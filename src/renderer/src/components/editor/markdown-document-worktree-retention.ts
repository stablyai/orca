import type { MarkdownDocument } from '../../../../shared/types'
import { assertMarkdownDocumentsWithinLimit } from '../../../../shared/markdown-document-listing-limits'

export const MARKDOWN_DOCUMENT_WORKTREE_MAX_SNAPSHOTS = 8
export const MARKDOWN_DOCUMENT_WORKTREE_MAX_RETAINED_BYTES = 32 * 1024 * 1024

export type MarkdownDocumentWorktreeSnapshot = {
  documents: MarkdownDocument[]
  retainedBytes: number
}

export function retainMarkdownDocumentWorktreeSnapshot(
  previous: ReadonlyMap<string, MarkdownDocumentWorktreeSnapshot>,
  worktreeId: string,
  documents: MarkdownDocument[],
  limits: { maxSnapshots: number; maxRetainedBytes: number } = {
    maxSnapshots: MARKDOWN_DOCUMENT_WORKTREE_MAX_SNAPSHOTS,
    maxRetainedBytes: MARKDOWN_DOCUMENT_WORKTREE_MAX_RETAINED_BYTES
  }
): Map<string, MarkdownDocumentWorktreeSnapshot> {
  const next = new Map(previous)
  next.delete(worktreeId)
  next.set(worktreeId, {
    documents,
    retainedBytes: assertMarkdownDocumentsWithinLimit(documents)
  })

  let retainedBytes = 0
  for (const snapshot of next.values()) {
    retainedBytes += snapshot.retainedBytes
  }
  while (next.size > limits.maxSnapshots || retainedBytes > limits.maxRetainedBytes) {
    const oldestKey = next.keys().next().value
    if (typeof oldestKey !== 'string') {
      break
    }
    retainedBytes -= next.get(oldestKey)?.retainedBytes ?? 0
    next.delete(oldestKey)
  }
  return next
}
