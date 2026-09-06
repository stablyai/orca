import { z } from 'zod'
import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH
} from '../agent-status-limits'
import { MobileWebRelativePathSchema } from './file-operation-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'
import { MobileWebNativeChatTargetShape } from './native-chat-target-contract'

export * from './native-chat-image-operation-contract'
export { MobileWebNativeChatSessionIdSchema } from './native-chat-target-contract'

export const MOBILE_WEB_NATIVE_CHAT_READ_LIMIT = 2000
export const MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT = 16
export const MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES = 512 * 1024
export const MOBILE_WEB_NATIVE_CHAT_PENDING_DELIVERY_LIMIT = 16
export const MOBILE_WEB_NATIVE_CHAT_PENDING_TEXT_MAX_CHARACTERS = 4096
export const MOBILE_WEB_NATIVE_CHAT_MAX_DEADLINE_AHEAD_MS = 30_000

const OptionalBoundedTextSchema = (maximum: number) => z.string().min(1).max(maximum).optional()

export const MobileWebNativeChatAgentStatusSchema = z
  .object({
    state: z.enum(['working', 'blocked', 'waiting', 'done']),
    stateStartedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    agentType: OptionalBoundedTextSchema(AGENT_TYPE_MAX_LENGTH),
    model: OptionalBoundedTextSchema(AGENT_MODEL_MAX_LENGTH),
    toolName: OptionalBoundedTextSchema(AGENT_STATUS_TOOL_NAME_MAX_LENGTH),
    toolInput: OptionalBoundedTextSchema(AGENT_STATUS_TOOL_INPUT_MAX_LENGTH),
    interactivePrompt: OptionalBoundedTextSchema(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH),
    lastAssistantMessage: OptionalBoundedTextSchema(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH),
    /** Marks `lastAssistantMessage` as tool output, so the streaming preview stays suppressed. */
    lastAssistantMessageIsToolOutput: z.boolean().optional(),
    // Inlined like `state` above: the page bundle cannot reach `agent-status-types`. Kept equal to
    // `AGENT_WORKING_MODES` by a test. A closed set, so the tolerant page parse collapses an
    // unknown future mode to absent — the pre-field reading of a foreground agent.
    workingMode: z.enum(['monitoring']).optional(),
    interrupted: z.boolean().optional()
  })
  .strict()

export const MobileWebNativeChatLifecycleSchema = z
  .object({
    state: z.enum(['working', 'completed', 'interrupted']),
    turnId: z.string().min(1).max(1024),
    timestamp: z.number().finite().nullable()
  })
  .strict()

export const MobileWebNativeChatLaunchAgentSchema = z.string().min(1).max(AGENT_TYPE_MAX_LENGTH)

const MobileWebNativeChatDeadlineShape = {
  deadline: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
} as const

const MobileWebNativeChatTextBlockSchema = z
  .object({ type: z.literal('text'), text: z.string().max(4200) })
  .strict()
const MobileWebNativeChatToolCallBlockSchema = z
  .object({
    type: z.literal('tool-call'),
    name: z.string().min(1).max(256),
    input: z.unknown(),
    /** Provider lifecycle. Absent on the transcript lane, where the turn's working flag decides. */
    state: z.enum(['running', 'completed', 'failed']).optional()
  })
  .strict()
const MobileWebNativeChatToolResultBlockSchema = z
  .object({
    type: z.literal('tool-result'),
    output: z.string().max(4200),
    isError: z.boolean().optional()
  })
  .strict()
const MobileWebNativeChatImageRefBlockSchema = z
  .object({
    type: z.literal('image-ref'),
    path: z.string().max(4096).optional(),
    url: z.string().max(4096).optional(),
    alt: z.string().max(512).optional()
  })
  .strict()

export const MobileWebNativeChatMessageSchema = z
  .object({
    id: z.string().min(1).max(1024),
    role: z.enum(['user', 'assistant', 'tool', 'reasoning', 'system']),
    blocks: z
      .array(
        z.discriminatedUnion('type', [
          MobileWebNativeChatTextBlockSchema,
          MobileWebNativeChatToolCallBlockSchema,
          MobileWebNativeChatToolResultBlockSchema,
          MobileWebNativeChatImageRefBlockSchema
        ])
      )
      .max(64),
    timestamp: z.number().finite().nullable(),
    source: z.enum(['transcript', 'hook', 'scrape']),
    turnId: z.string().min(1).max(1024).optional()
  })
  .strict()

export const MobileWebNativeChatReadPayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    limit: z.number().int().min(1).max(MOBILE_WEB_NATIVE_CHAT_READ_LIMIT),
    beforeOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

export const MobileWebNativeChatSubscribePayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    limit: z.number().int().min(1).max(MOBILE_WEB_NATIVE_CHAT_READ_LIMIT)
  })
  .strict()

export const MobileWebNativeChatReadResultSchema = z
  .object({
    messages: z.array(MobileWebNativeChatMessageSchema).max(MOBILE_WEB_NATIVE_CHAT_READ_LIMIT),
    hasMore: z.boolean(),
    beforeOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    lifecycle: MobileWebNativeChatLifecycleSchema.optional()
  })
  .strict()

export const MobileWebNativeChatEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.enum(['snapshot', 'replacement', 'appended']),
      messages: z.array(MobileWebNativeChatMessageSchema).max(MOBILE_WEB_NATIVE_CHAT_READ_LIMIT),
      hasMore: z.boolean().optional(),
      beforeOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      error: z.string().min(1).max(512).optional(),
      lifecycle: MobileWebNativeChatLifecycleSchema.optional()
    })
    .strict(),
  z.object({ type: z.literal('error'), message: z.string().min(1).max(512) }).strict(),
  z.object({ type: z.literal('end') }).strict()
])

export const MobileWebNativeChatSendMessagePayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    ...MobileWebNativeChatDeadlineShape,
    text: z
      .string()
      .min(1)
      .max(64 * 1024),
    clearInputFirst: z.boolean().optional(),
    typeCommand: z.boolean().optional(),
    resolvedLaunchDraft: z
      .object({
        text: z.string().max(64 * 1024),
        createdAt: z.number().finite()
      })
      .strict()
      .optional()
  })
  .strict()
export const MobileWebNativeChatRespondPayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    ...MobileWebNativeChatDeadlineShape,
    text: z.string().min(1).max(4096),
    enter: z.boolean()
  })
  .strict()
export const MobileWebNativeChatStopPayloadSchema = z
  .object({ ...MobileWebNativeChatTargetShape, ...MobileWebNativeChatDeadlineShape })
  .strict()

export const MobileWebNativeChatSendResultSchema = z
  .object({ outcome: z.enum(['accepted', 'rejected', 'unknown']) })
  .strict()

export const MobileWebNativeChatPrepareCommitPayloadSchema = z
  .object({ ...MobileWebNativeChatTargetShape, ...MobileWebNativeChatDeadlineShape })
  .strict()
export const MobileWebNativeChatPrepareCommitResultSchema = z
  .object({ prepared: z.boolean() })
  .strict()

export const MobileWebNativeChatPendingDeliverySchema = z
  .object({
    text: z.string().min(1).max(MOBILE_WEB_NATIVE_CHAT_PENDING_TEXT_MAX_CHARACTERS),
    expectedOccurrence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export const MobileWebNativeChatPendingReadPayloadSchema = z
  .object(MobileWebNativeChatTargetShape)
  .strict()
export const MobileWebNativeChatPendingReadResultSchema = z
  .object({
    deliveries: z
      .array(MobileWebNativeChatPendingDeliverySchema)
      .max(MOBILE_WEB_NATIVE_CHAT_PENDING_DELIVERY_LIMIT)
  })
  .strict()
export const MobileWebNativeChatPendingWritePayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    deliveries: z
      .array(MobileWebNativeChatPendingDeliverySchema)
      .max(MOBILE_WEB_NATIVE_CHAT_PENDING_DELIVERY_LIMIT)
  })
  .strict()
export const MobileWebNativeChatPendingWriteResultSchema = z.null()

export const MobileWebNativeChatFileSearchPayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    query: z.string().max(256)
  })
  .strict()
export const MobileWebNativeChatFileSearchResultSchema = z
  .object({
    paths: z.array(MobileWebRelativePathSchema).max(MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT)
  })
  .strict()
export const MobileWebNativeChatOpenFilePayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    pathText: z.string().min(1).max(4096)
  })
  .strict()
export const MobileWebNativeChatOpenFileResultSchema = z.null()

export const MobileWebNativeChatReadabilityPayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()
export const MobileWebNativeChatReadabilityResultSchema = z
  .object({ readable: z.boolean() })
  .strict()

export type MobileWebNativeChatAgentStatus = z.infer<typeof MobileWebNativeChatAgentStatusSchema>
export type MobileWebNativeChatReadPayload = z.infer<typeof MobileWebNativeChatReadPayloadSchema>
export type MobileWebNativeChatSubscribePayload = z.infer<
  typeof MobileWebNativeChatSubscribePayloadSchema
>
export type MobileWebNativeChatReadResult = z.infer<typeof MobileWebNativeChatReadResultSchema>
export type MobileWebNativeChatEvent = z.infer<typeof MobileWebNativeChatEventSchema>
export type MobileWebNativeChatSendMessagePayload = z.infer<
  typeof MobileWebNativeChatSendMessagePayloadSchema
>
export type MobileWebNativeChatRespondPayload = z.infer<
  typeof MobileWebNativeChatRespondPayloadSchema
>
export type MobileWebNativeChatStopPayload = z.infer<typeof MobileWebNativeChatStopPayloadSchema>
export type MobileWebNativeChatSendResult = z.infer<typeof MobileWebNativeChatSendResultSchema>
export type MobileWebNativeChatPrepareCommitPayload = z.infer<
  typeof MobileWebNativeChatPrepareCommitPayloadSchema
>
export type MobileWebNativeChatPendingReadPayload = z.infer<
  typeof MobileWebNativeChatPendingReadPayloadSchema
>
export type MobileWebNativeChatPendingReadResult = z.infer<
  typeof MobileWebNativeChatPendingReadResultSchema
>
export type MobileWebNativeChatPendingWritePayload = z.infer<
  typeof MobileWebNativeChatPendingWritePayloadSchema
>
export type MobileWebNativeChatFileSearchPayload = z.infer<
  typeof MobileWebNativeChatFileSearchPayloadSchema
>
export type MobileWebNativeChatFileSearchResult = z.infer<
  typeof MobileWebNativeChatFileSearchResultSchema
>
export type MobileWebNativeChatOpenFilePayload = z.infer<
  typeof MobileWebNativeChatOpenFilePayloadSchema
>
export type MobileWebNativeChatReadabilityPayload = z.infer<
  typeof MobileWebNativeChatReadabilityPayloadSchema
>
