import { normalizeWorkspaceAttachmentOrigins } from './workspace-attachment-origins'
import { z } from 'zod'
import { normalizeWorkspaceAttachment } from './workspace-attachment-normalization'
import type { WorkspaceAttachment } from './worktree/types'

export const WorkspaceAttachmentSchema = z
  .unknown()
  .transform((value, ctx): WorkspaceAttachment => {
    const item = normalizeWorkspaceAttachment(value)
    if (!item) {
      ctx.addIssue({ code: 'custom', message: 'Invalid workspace attachment' })
      return z.NEVER
    }
    if (
      value &&
      typeof value === 'object' &&
      'taskSourceContext' in value &&
      value.taskSourceContext !== undefined &&
      !item.taskSourceContext
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid attachment task source context' })
      return z.NEVER
    }
    if (
      value &&
      typeof value === 'object' &&
      'origins' in value &&
      value.origins !== undefined &&
      (!Array.isArray(value.origins) ||
        value.origins.length > 128 ||
        value.origins.some((origin) => normalizeWorkspaceAttachmentOrigins([origin]).length !== 1))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid attachment origins' })
      return z.NEVER
    }
    return item
  })

export const WorkspaceAttachmentsSchema = z.array(WorkspaceAttachmentSchema)
