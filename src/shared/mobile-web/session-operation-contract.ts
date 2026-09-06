import { z } from 'zod'
import { MobileWebRelativePathSchema } from './file-operation-contract'
import {
  MobileWebNativeChatAgentStatusSchema,
  MobileWebNativeChatLaunchAgentSchema,
  MobileWebNativeChatSessionIdSchema
} from './native-chat-operation-contract'
import { matchesMobileWebProtocolToken } from './protocol-token-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MOBILE_WEB_SESSION_TAB_LIMIT = 200
export const MOBILE_WEB_SESSION_EVENT_MAX_BYTES = 128 * 1024
export const MOBILE_WEB_SESSION_AGENT_LIMIT = 40

export const MobileWebSessionSnapshotPayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()
export const MobileWebSessionSubscribePayloadSchema = MobileWebSessionSnapshotPayloadSchema
export const MobileWebSessionCreatePayloadSchema = MobileWebSessionSnapshotPayloadSchema
export const MobileWebSessionAgentOptionsPayloadSchema = MobileWebSessionSnapshotPayloadSchema
const MobileWebSessionAgentSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => matchesMobileWebProtocolToken(value, /^[a-z0-9-]+$/))
export const MobileWebSessionCreateAgentPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    agent: MobileWebSessionAgentSchema
  })
  .strict()
export const MobileWebSessionCapabilitiesPayloadSchema = z.object({}).strict()
export const MobileWebSessionHostGatesPayloadSchema = z
  .object({ includeHostGates: z.literal(true) })
  .strict()
export const MobileWebSessionBrowserCreatePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    url: z.string().min(1).max(4096).refine(isAllowedBrowserUrl, 'Unsupported browser URL')
  })
  .strict()

export const MobileWebSessionTabActionPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    tabId: z.string().min(1).max(512)
  })
  .strict()

const MobileWebSessionTabBase = {
  id: z.string().min(1).max(512),
  title: z.string().min(1).max(240),
  isActive: z.boolean()
} as const
const MobileWebSessionLanguageSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => matchesMobileWebProtocolToken(value, /^[A-Za-z0-9_+.-]+$/))

export const MobileWebSessionTabSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...MobileWebSessionTabBase,
      type: z.literal('terminal'),
      status: z.enum(['pending-handle', 'ready']),
      launchAgent: MobileWebNativeChatLaunchAgentSchema.optional(),
      agentStatus: MobileWebNativeChatAgentStatusSchema.optional(),
      nativeChatSessionId: MobileWebNativeChatSessionIdSchema.optional()
    })
    .strict(),
  z
    .object({
      ...MobileWebSessionTabBase,
      type: z.literal('markdown'),
      relativePath: MobileWebRelativePathSchema.optional(),
      isDirty: z.boolean().optional(),
      language: z.literal('markdown').optional(),
      mode: z.enum(['edit', 'markdown-preview']).optional()
    })
    .strict(),
  z
    .object({
      ...MobileWebSessionTabBase,
      type: z.literal('file'),
      relativePath: MobileWebRelativePathSchema.optional(),
      language: MobileWebSessionLanguageSchema.optional(),
      mode: z.enum(['edit', 'diff']).optional(),
      diffSource: z.enum(['staged', 'unstaged', 'branch', 'commit']).optional()
    })
    .strict(),
  z
    .object({
      ...MobileWebSessionTabBase,
      type: z.literal('browser'),
      browserPageId: z.string().min(1).max(512),
      url: z.string().max(4096),
      loading: z.boolean(),
      canGoBack: z.boolean(),
      canGoForward: z.boolean()
    })
    .strict()
])

export const MobileWebSessionSnapshotResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    publicationEpoch: z.string().min(1).max(128),
    snapshotVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    workspaceTransportState: z.enum(['available', 'unavailable']).optional(),
    activeTabId: z.string().min(1).max(512).nullable(),
    activeTabType: z.enum(['terminal', 'markdown', 'file', 'browser']).nullable(),
    tabs: z.array(MobileWebSessionTabSchema).max(MOBILE_WEB_SESSION_TAB_LIMIT),
    truncated: z.boolean()
  })
  .strict()
export const MobileWebSessionEventSchema = MobileWebSessionSnapshotResultSchema

export const MobileWebSessionCreateResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    tabId: z.string().min(1).max(512),
    created: z.literal(true)
  })
  .strict()

export const MobileWebSessionAgentOptionsResultSchema = z
  .object({
    agents: z.array(MobileWebSessionAgentSchema).max(MOBILE_WEB_SESSION_AGENT_LIMIT)
  })
  .strict()

export const MobileWebSessionBrowserCreateResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    browserPageId: z.string().min(1).max(512)
  })
  .strict()

export const MobileWebSessionCloseResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    tabId: z.string().min(1).max(512),
    outcome: z.enum(['closed', 'refused']),
    refusalReason: z
      .enum([
        'missing-intent',
        'stale-publication',
        'stale-terminal',
        'live-host-pty',
        'unknown-liveness',
        'retirement-owner'
      ])
      .nullable()
  })
  .strict()

export const MobileWebSessionCapabilitiesResultSchema = z
  .object({
    browserScreencastSupported: z.boolean(),
    agentHistorySupported: z.boolean(),
    quickCommandsSupported: z.boolean(),
    terminalQueryReplyInputSupported: z.boolean()
  })
  .strict()

export const MobileWebSessionHostGatesResultSchema = z
  .object({
    hostCapabilities: z.array(z.string().min(1).max(120)).max(256),
    floatingWorkspaceEnabled: z.boolean()
  })
  .strict()

export type MobileWebSessionSnapshotPayload = z.infer<typeof MobileWebSessionSnapshotPayloadSchema>
export type MobileWebSessionSubscribePayload = z.infer<
  typeof MobileWebSessionSubscribePayloadSchema
>
export type MobileWebSessionCreatePayload = z.infer<typeof MobileWebSessionCreatePayloadSchema>
export type MobileWebSessionAgentOptionsPayload = z.infer<
  typeof MobileWebSessionAgentOptionsPayloadSchema
>
export type MobileWebSessionCreateAgentPayload = z.infer<
  typeof MobileWebSessionCreateAgentPayloadSchema
>
export type MobileWebSessionCapabilitiesPayload = z.infer<
  typeof MobileWebSessionCapabilitiesPayloadSchema
>
export type MobileWebSessionHostGatesPayload = z.infer<
  typeof MobileWebSessionHostGatesPayloadSchema
>
export type MobileWebSessionBrowserCreatePayload = z.infer<
  typeof MobileWebSessionBrowserCreatePayloadSchema
>
export type MobileWebSessionTabActionPayload = z.infer<
  typeof MobileWebSessionTabActionPayloadSchema
>
export type MobileWebSessionTab = z.infer<typeof MobileWebSessionTabSchema>
export type MobileWebSessionSnapshotResult = z.infer<typeof MobileWebSessionSnapshotResultSchema>
export type MobileWebSessionCreateResult = z.infer<typeof MobileWebSessionCreateResultSchema>
export type MobileWebSessionAgentOptionsResult = z.infer<
  typeof MobileWebSessionAgentOptionsResultSchema
>
export type MobileWebSessionBrowserCreateResult = z.infer<
  typeof MobileWebSessionBrowserCreateResultSchema
>
export type MobileWebSessionCloseResult = z.infer<typeof MobileWebSessionCloseResultSchema>
export type MobileWebSessionCapabilitiesResult = z.infer<
  typeof MobileWebSessionCapabilitiesResultSchema
>
export type MobileWebSessionHostGatesResult = z.infer<typeof MobileWebSessionHostGatesResultSchema>

function isAllowedBrowserUrl(value: string): boolean {
  if (value === 'about:blank') {
    return true
  }
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:'
  } catch {
    return false
  }
}
