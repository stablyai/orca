import { z } from 'zod'
import { WorkspaceLinkedItemSchema } from '../workspace-attachments/workspace-linked-item-schema'
import { WorkspaceAttachmentsSchema } from '../workspace-attachments/workspace-attachment-schema'
import { TaskSourceContextSchema } from '../work-items/task-source-context-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../workspace-attachments/workspace-linked-item-source-context'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'
import { DiffCommentSchema } from '../diff-comment-schema'
import { sleepingAgentLaunchConfigSchema } from '../workspace-session/workspace-session-sleeping-agents'
import { AgentArgs, LaunchPreferences } from './agent-session-params'
import { LaunchSourceParam } from './launch-source-param'

export const FolderWorkspaceHookCreateShape = {
  runHooks: z.boolean().optional(),
  setupDecision: z.enum(['run', 'skip', 'inherit']).optional(),
  approvedSetupHash: z.string().max(128).optional(),
  approvedSetupHashes: z.array(z.string().max(128)).max(64).optional(),
  agentLaunchMode: z.literal('structured').optional(),
  startupCommand: OptionalString,
  startupEnv: z.record(z.string(), z.string()).optional(),
  startupLaunchConfig: sleepingAgentLaunchConfigSchema,
  startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
  startupAgent: z.string().refine(isTuiAgent).optional(),
  startupPrompt: OptionalString,
  startupPromptDelivery: z.enum(['draft', 'auto-submit']).optional(),
  startupAgentArgs: AgentArgs.optional(),
  startupSessionOptions: z.record(z.string(), z.string()).optional(),
  startupLaunchPreferences: LaunchPreferences.optional(),
  launchSource: LaunchSourceParam.optional()
}

export function assertFolderWorkspaceStartupDelivery(
  value: {
    startupPromptDelivery?: string
    startupCommand?: string
    startupAgent?: string
    startupPrompt?: string
  },
  ctx: z.RefinementCtx
): void {
  if (
    value.startupPromptDelivery &&
    (!value.startupCommand?.trim() || !value.startupAgent || !value.startupPrompt?.trim())
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Startup prompt delivery requires a command, agent and text'
    })
  }
}

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
    ...FolderWorkspaceHookCreateShape,
    projectGroupId: requiredString('Missing project group id'),
    name: OptionalString,
    folderPath: OptionalString.nullable().optional(),
    connectionId: OptionalString.nullable().optional(),
    linkedTask: FolderWorkspaceLinkedTask.optional(),
    linkedItems: WorkspaceAttachmentsSchema.optional(),

    linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
    createdWithAgent: z.string().refine(isTuiAgent).optional(),
    pendingFirstAgentMessageRename: z.boolean().optional()
  })
  .superRefine(assertLinkedTaskSourceContextMatch)
  .superRefine(assertFolderWorkspaceStartupDelivery)

// Hosts advertising the unique-id mutation capability refuse a shared folder id when this is set.
const RequireUniqueId = z.boolean().optional()

export const FolderWorkspaceUpdate = z.object({
  folderWorkspaceId: requiredString('Missing folder workspace id'),
  requireUniqueId: RequireUniqueId,
  updates: z
    .object({
      name: OptionalString,
      folderPath: OptionalString,
      linkedTask: FolderWorkspaceLinkedTask.optional(),
      linkedItems: WorkspaceAttachmentsSchema.optional(),
      linkedItemsBase: WorkspaceAttachmentsSchema.optional(),
      linkedItemsSelectionChanged: z.boolean().optional(),
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

export const FolderWorkspaceDelete = FolderWorkspaceSelector.extend({
  requireUniqueId: RequireUniqueId
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
