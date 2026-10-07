import { z } from 'zod'
import { WorkspaceLinkedItemSchema } from '../workspace-linked-item-schema'
import { TaskSourceContextSchema } from '../task-source-context-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../workspace-linked-item-source-context'
import { isTuiAgent } from '../tui-agent-config'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'
import { DiffCommentSchema } from '../diff-comment-schema'

export const FolderWorkspaceLinkedTask = WorkspaceLinkedItemSchema.nullable()

export function assertLinkedTaskSourceContextMatch(
  value: {
    linkedTask?: z.infer<typeof FolderWorkspaceLinkedTask>
    linkedTaskSourceContext?: z.infer<typeof TaskSourceContextSchema> | null
  },
  ctx: z.RefinementCtx
): void {
  if (
    value.linkedTask &&
    value.linkedTaskSourceContext &&
    !isWorkspaceLinkedItemSourceContextMatch(value.linkedTask, value.linkedTaskSourceContext)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Linked task and source context identities must match'
    })
  }
}

export const FolderWorkspaceCreate = z
  .object({
    projectGroupId: requiredString('Missing project group id'),
    name: OptionalString,
    folderPath: OptionalString.nullable().optional(),
    connectionId: OptionalString.nullable().optional(),
    linkedTask: FolderWorkspaceLinkedTask.optional(),
    linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
    createdWithAgent: z.string().refine(isTuiAgent).optional(),
    pendingFirstAgentMessageRename: z.boolean().optional()
  })
  .superRefine(assertLinkedTaskSourceContextMatch)

export const FolderWorkspaceUpdate = z.object({
  folderWorkspaceId: requiredString('Missing folder workspace id'),
  updates: z
    .object({
      name: OptionalString,
      folderPath: OptionalString,
      linkedTask: FolderWorkspaceLinkedTask.optional(),
      linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
      comment: z.string().optional(),
      isArchived: z.boolean().optional(),
      isUnread: z.boolean().optional(),
      isPinned: z.boolean().optional(),
      sortOrder: OptionalFiniteNumber,
      manualOrder: OptionalFiniteNumber,
      workspaceStatus: OptionalString,
      createdWithAgent: z.string().refine(isTuiAgent).optional(),
      pendingFirstAgentMessageRename: z.boolean().optional(),
      firstAgentMessageRenameError: z.string().nullable().optional(),
      lastActivityAt: OptionalFiniteNumber,
      diffComments: z.array(DiffCommentSchema).optional()
    })
    .superRefine(assertLinkedTaskSourceContextMatch)
})

export const FolderWorkspaceSelector = z.object({
  folderWorkspaceId: requiredString('Missing folder workspace id')
})

export const FolderWorkspacePathStatus = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('folder-workspace'),
    folderWorkspaceId: requiredString('Missing folder workspace id')
  }),
  z.object({
    scope: z.literal('project-group'),
    projectGroupId: requiredString('Missing project group id')
  }),
  z.object({
    scope: z.literal('path'),
    path: requiredString('Missing folder path'),
    connectionId: OptionalString.nullable().optional()
  })
])
