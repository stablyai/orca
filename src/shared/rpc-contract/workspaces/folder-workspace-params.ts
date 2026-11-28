import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { WorkspaceLinkedItemSchema } from '../../workspace-attachments/workspace-linked-item-schema'
import { WorkspaceAttachmentsSchema } from '../../workspace-attachments/workspace-attachment-schema'
import { TaskSourceContextSchema } from '../../work-items/task-source-context-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../workspace-attachments/workspace-linked-item-source-context'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../rpc-param-primitives'
import {
  DiffCommentDeliverySnapshotSchema,
  DiffCommentSchema
} from '../../file-review/diff-comment-schema'
import { sleepingAgentLaunchConfigSchema } from '../../workspace-session/workspace-session-sleeping-agents'
import { AgentArgs, LaunchPreferences } from '../terminal/agent-session-params'
import { LaunchSourceParam } from '../agent-launch/launch-source-param'

export const FolderWorkspaceHookCreateShape = {
  runHooks: lazyZodSchema(() => z.boolean().optional()),
  setupDecision: lazyZodSchema(() => z.enum(['run', 'skip', 'inherit']).optional()),
  approvedSetupHash: lazyZodSchema(() => z.string().max(128).optional()),
  approvedSetupHashes: lazyZodSchema(() => z.array(z.string().max(128)).max(64).optional()),
  agentLaunchMode: lazyZodSchema(() => z.literal('structured').optional()),
  startupCommand: OptionalString,
  startupEnv: lazyZodSchema(() => z.record(z.string(), z.string()).optional()),
  startupLaunchConfig: sleepingAgentLaunchConfigSchema,
  startupCommandDelivery: lazyZodSchema(() => z.enum(['fast', 'shell-ready']).optional()),
  startupAgent: lazyZodSchema(() => z.string().refine(isTuiAgent).optional()),
  startupPrompt: OptionalString,
  startupDraft: OptionalString,
  startupAgentArgs: lazyZodSchema(() => AgentArgs.optional()),
  startupSessionOptions: lazyZodSchema(() => z.record(z.string(), z.string()).optional()),
  startupLaunchPreferences: lazyZodSchema(() => LaunchPreferences.optional()),
  launchSource: lazyZodSchema(() => LaunchSourceParam.optional())
}

export function assertFolderWorkspaceStartup(
  value: { startupAgent?: string; startupPrompt?: string },
  ctx: z.RefinementCtx
): void {
  if (value.startupPrompt !== undefined && value.startupAgent === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'startupPrompt requires startupAgent' })
  }
}

export const FolderWorkspaceLinkedTask = lazyZodSchema(() => WorkspaceLinkedItemSchema.nullable())

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

export const FolderWorkspaceCreate = lazyZodSchema(() =>
  z
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
    .superRefine(assertFolderWorkspaceStartup)
)

// Hosts advertising the unique-id mutation capability refuse a shared folder id when this is set.
const RequireUniqueId = lazyZodSchema(() => z.boolean().optional())

export const FolderWorkspaceUpdate = lazyZodSchema(() =>
  z.object({
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
        diffComments: z.array(DiffCommentSchema).optional(),
        diffCommentsBase: z.array(DiffCommentSchema).optional(),
        deliveredDiffCommentSnapshots: z.array(DiffCommentDeliverySnapshotSchema).optional()
      })
      .superRefine(assertLinkedTaskSourceContextMatch)
  })
)

export const FolderWorkspaceSelector = lazyZodSchema(() =>
  z.object({
    folderWorkspaceId: requiredString('Missing folder workspace id')
  })
)

export const FolderWorkspaceDelete = lazyZodSchema(() =>
  FolderWorkspaceSelector.extend({
    requireUniqueId: RequireUniqueId,
    runHooks: z.boolean().optional(),
    allowFailedArchiveHook: z.boolean().optional()
  })
)

export const FolderWorkspacePathStatus = lazyZodSchema(() =>
  z.discriminatedUnion('scope', [
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
)
