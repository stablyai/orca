import { z } from 'zod'
import {
  MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH,
  MAX_QUICK_COMMAND_ID_LENGTH,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH,
  MAX_QUICK_COMMANDS
} from '../terminal-quick-command-limits'
import { matchesMobileWebProtocolToken } from './protocol-token-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

const MobileWebQuickCommandAgentSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => matchesMobileWebProtocolToken(value, /^[a-z0-9-]+$/))
const MobileWebQuickCommandScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z
    .object({
      type: z.literal('repo'),
      repoId: MobileWebWorkspaceIdSchema
    })
    .strict()
])
const MobileWebQuickCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      id: z.string().min(1).max(MAX_QUICK_COMMAND_ID_LENGTH),
      label: z.string().max(MAX_QUICK_COMMAND_LABEL_LENGTH),
      action: z.literal('terminal-command'),
      command: z.string().max(MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH),
      appendEnter: z.boolean(),
      scope: MobileWebQuickCommandScopeSchema
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(MAX_QUICK_COMMAND_ID_LENGTH),
      label: z.string().max(MAX_QUICK_COMMAND_LABEL_LENGTH),
      action: z.literal('agent-prompt'),
      agent: MobileWebQuickCommandAgentSchema,
      prompt: z.string().max(MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH),
      scope: MobileWebQuickCommandScopeSchema
    })
    .strict()
])

export const MobileWebQuickCommandSnapshotPayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()
export const MobileWebQuickCommandMutationPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    mutation: z.discriminatedUnion('type', [
      z.object({ type: z.literal('upsert'), command: MobileWebQuickCommandSchema }).strict(),
      z
        .object({
          type: z.literal('delete'),
          id: z.string().min(1).max(MAX_QUICK_COMMAND_ID_LENGTH)
        })
        .strict()
    ])
  })
  .strict()
export const MobileWebQuickCommandLaunchPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    commandId: z.string().min(1).max(MAX_QUICK_COMMAND_ID_LENGTH)
  })
  .strict()
export const MobileWebQuickCommandSnapshotResultSchema = z
  .object({
    commands: z.array(MobileWebQuickCommandSchema).max(MAX_QUICK_COMMANDS),
    totalCount: z.number().int().nonnegative().max(MAX_QUICK_COMMANDS),
    repoId: MobileWebWorkspaceIdSchema.nullable()
  })
  .strict()
export const MobileWebQuickCommandLaunchResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    tabId: z.string().min(1).max(512),
    created: z.literal(true),
    initialInput: z
      .object({
        text: z.string().min(1).max(MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH),
        enter: z.literal(false),
        successToast: z
          .string()
          .min(1)
          .max(MAX_QUICK_COMMAND_LABEL_LENGTH + 16)
      })
      .strict()
      .nullable()
  })
  .strict()

export type MobileWebQuickCommandSnapshotPayload = z.infer<
  typeof MobileWebQuickCommandSnapshotPayloadSchema
>
export type MobileWebQuickCommandMutationPayload = z.infer<
  typeof MobileWebQuickCommandMutationPayloadSchema
>
export type MobileWebQuickCommandLaunchPayload = z.infer<
  typeof MobileWebQuickCommandLaunchPayloadSchema
>
export type MobileWebQuickCommandSnapshotResult = z.infer<
  typeof MobileWebQuickCommandSnapshotResultSchema
>
export type MobileWebQuickCommandLaunchResult = z.infer<
  typeof MobileWebQuickCommandLaunchResultSchema
>
