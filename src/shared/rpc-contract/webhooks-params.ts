import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import type { AutomationBotResultsTo } from '../automations/automation-definition'
import {
  WEBHOOK_ADAPTERS,
  WEBHOOK_CALL_ID_PATTERN,
  WEBHOOK_HOOK_ID_PATTERN,
  WEBHOOK_WHERE_OPS,
  type WebhookAdapterId,
  type WebhookCallState,
  type WebhookFilters
} from '../connector-webhook-contract'
import { requiredString } from './rpc-param-primitives'

// The chat card and the Webhooks row read hooks through these, from the bot's execution host. Only
// Orca's UI calls webhooks.reveal: no CLI command or agent tool prints a key.

/** Why a webhooks.* call refused. */
export const WEBHOOK_ERROR_CODES = [
  'webhook_not_found',
  // The cloud doesn't advertise webhooks.
  'webhooks_unavailable',
  'host_offline',
  'host_needs_update'
] as const

const HookId = lazyZodSchema(() => z.string().regex(WEBHOOK_HOOK_ID_PATTERN, 'Missing hook id'))

/** webhooks.card → WebhookSummary. */
export const WebhookCard = lazyZodSchema(() => z.object({ hookId: HookId }))
/** webhooks.list → { hooks: WebhookSummary[] }: the bot's hooks, for the Webhooks row. */
export const WebhooksList = lazyZodSchema(() =>
  z.object({ botId: requiredString('Missing bot id') })
)
/** webhooks.calls → { calls: WebhookCallRow[] }: the hook's recent calls, newest first. */
export const WebhookCalls = lazyZodSchema(() => z.object({ hookId: HookId }))
/** webhooks.reveal → WebhookKey, on the owner's click. */
export const WebhookReveal = lazyZodSchema(() => z.object({ hookId: HookId }))

const CallId = lazyZodSchema(() => z.string().regex(WEBHOOK_CALL_ID_PATTERN, 'Missing call id'))
const OperationId = requiredString('Missing operation id')
const Filter = lazyZodSchema(() => z.string().min(1))

/** webhooks.call → WebhookCallText: one call, fenced as the caller's words. */
export const WebhookCallShow = lazyZodSchema(() => z.object({ hookId: HookId, callId: CallId }))
/** webhooks.check → WebhookCheckResult: how many recent calls the filters, or the hook's own, match. */
export const WebhookCheck = lazyZodSchema(() =>
  z.object({
    hookId: HookId,
    filters: z
      .object({
        where: z
          .array(
            z
              .object({
                path: Filter,
                op: z.enum(WEBHOOK_WHERE_OPS),
                values: z.array(z.string()).optional()
              })
              .strict()
          )
          .optional(),
        textContains: Filter.optional(),
        pick: z.array(Filter).optional(),
        subjectFrom: Filter.optional(),
        subject: Filter.optional()
      })
      .strict()
      .optional()
  })
)
/** webhooks.sample → { callId }: a real run, flagged as a sample, that skips the sender's checks. One per click's operationId. */
export const WebhookSample = lazyZodSchema(() =>
  z.object({ hookId: HookId, operationId: OperationId })
)
/** webhooks.pause: pauses or resumes the hook's automation, and so the hook. */
export const WebhookPause = lazyZodSchema(() => z.object({ hookId: HookId, paused: z.boolean() }))
/** webhooks.delete: deletes the hook; its automation goes too when nothing else starts it. */
export const WebhookDelete = lazyZodSchema(() => z.object({ hookId: HookId }))
/** webhooks.rotate → { cancelledCalls }: a new key; stopNow fails the old one at once. */
export const WebhookRotate = lazyZodSchema(() =>
  z.object({
    hookId: HookId,
    operationId: OperationId,
    stopNow: z.boolean()
  })
)
/** webhooks.secret → { secret? }: a pasted provider secret, or one Orca generates and shows once here. */
export const WebhookSecret = lazyZodSchema(() =>
  z.object({
    hookId: HookId,
    operationId: OperationId,
    adapter: z.enum(WEBHOOK_ADAPTERS),
    secret: z.string().min(1).optional(),
    generate: z.literal(true).optional()
  })
)

/** Recent calls the filters match, don't match, or can't be told (body cut short or no longer kept).
 *  ignored: those of the unknown the hook's filters ignored, whose body was never kept; absent from
 *  an older host. */
export type WebhookCheckResult = {
  matched: number
  unmatched: number
  unknown: number
  ignored?: number
}

/** webhooks.call: the call fenced as the caller's words; ignored (an older host never says) when the
 *  cloud kept no body and text says why. */
export type WebhookCallText = { callId: string; text: string; ignored?: true }

/** What the card and row show; nothing in it is secret. */
export type WebhookSummary = {
  hookId: string
  botId: string
  automationId: string
  state: 'pending' | 'live' | 'paused' | 'orphaned'
  /** Without the key, for callers that send it as a Bearer header. */
  url: string
  /** Whose signature calls must carry, or null while the hook is key-only. */
  adapter: WebhookAdapterId | null
  lastCall: { at: number; state: WebhookCallState; signatureValid: boolean } | null
  /** Where the hook's execution host stands, in the wording other connectors use. */
  host: 'online' | 'offline'
  automationName: string
  /** Deleting the webhook deletes its automation too, since nothing else starts it. Older hosts omit it. */
  deletesAutomation?: boolean
  /** The automation's own destination, so the card and row never assume Chat. */
  resultsTo: AutomationBotResultsTo
  /** The rule’s filters, for the card and row. */
  filters: WebhookFilters
  /** Calls admitted but not yet started, which "stop now" would cancel. */
  pendingCalls: number
  /** Raised on each rotate. */
  keyGeneration: number
  /** When the key replaced with an overlap stops working; null when none is still live. */
  previousKeyExpiresAt: number | null
}

/** A call, or the refused, over-budget and duplicate requests of one minute counted together. */
export type WebhookCallRow =
  | {
      kind: 'call'
      callId: string
      receivedAt: number
      state: WebhookCallState
      sample?: true
      runId?: string
      /** The run's number in its automation's history. */
      runNumber?: number
      /** The run history's own reason, for unavailable, refused and failed. */
      reason?: string
    }
  | { kind: 'refused' | 'over_budget' | 'duplicate'; minute: number; count: number }

/** The key, and the URL that carries it in its path. */
export type WebhookKey = { key: string; url: string }

export type WebhookCardParams = z.infer<typeof WebhookCard>
export type WebhooksListParams = z.infer<typeof WebhooksList>
export type WebhookCallsParams = z.infer<typeof WebhookCalls>
export type WebhookRevealParams = z.infer<typeof WebhookReveal>
export type WebhookCheckParams = z.infer<typeof WebhookCheck>
export type WebhookSecretParams = z.infer<typeof WebhookSecret>
export type WebhookSampleParams = z.infer<typeof WebhookSample>
export type WebhookPauseParams = z.infer<typeof WebhookPause>
export type WebhookDeleteParams = z.infer<typeof WebhookDelete>
export type WebhookRotateParams = z.infer<typeof WebhookRotate>
