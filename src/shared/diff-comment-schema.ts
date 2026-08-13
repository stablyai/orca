import { z } from 'zod'
import type { DiffComment } from './types'

export const DiffCommentSchema = z
  .object({
    id: z.string().min(1),
    worktreeId: z.string().min(1),
    filePath: z.string().min(1),
    source: z.enum(['diff', 'markdown']).optional(),
    selectedText: z.string().optional(),
    startLine: z.number().int().positive().optional(),
    // Why: 0 marks a file-level note; line notes are 1-based.
    lineNumber: z.number().int().min(0),
    body: z.string().trim().min(1),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite().optional(),
    // Why: the renderer treats a non-positive sentAt as unsent, so never store one.
    sentAt: z.number().finite().positive().optional(),
    scope: z.enum(['unstaged', 'staged', 'branch']).optional(),
    oldPath: z.string().optional(),
    diffIdentity: z.string().optional(),
    side: z.literal('modified')
  })
  .refine((comment) => comment.startLine === undefined || comment.startLine <= comment.lineNumber, {
    message: 'startLine must not exceed lineNumber',
    path: ['startLine']
  })

// Why: persisted JSON predates the schema boundary, so drop unusable notes instead of rehydrating them.
export function parsePersistedDiffComments(value: unknown): DiffComment[] {
  if (!Array.isArray(value)) {
    return []
  }
  const comments: DiffComment[] = []
  for (const candidate of value) {
    const parsed = DiffCommentSchema.safeParse(candidate)
    if (parsed.success) {
      comments.push(parsed.data)
    }
  }
  return comments
}
