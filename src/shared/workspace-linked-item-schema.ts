import { z } from 'zod'
import type { WorkspaceLinkedItem } from './worktree/types'
import { normalizeWorkspaceLinkedItem } from './workspace-linked-item'

export const WorkspaceLinkedItemSchema = z
  .unknown()
  .transform((value, ctx): WorkspaceLinkedItem => {
    const normalized = normalizeWorkspaceLinkedItem(value)
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Invalid linked work item' })
      return z.NEVER
    }
    return normalized
  })
