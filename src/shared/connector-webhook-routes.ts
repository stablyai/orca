// Mirror of what cloud/packages/connector-contract/src/webhook-{routes,envelope}.ts answer, for the
// machine side; main imports the routes and request bodies from the cloud file itself. The shared
// JSON corpus pins both sides alike.
import * as z from 'zod'
import {
  WEBHOOK_ADAPTERS,
  WEBHOOK_CALL_ID_PATTERN,
  WEBHOOK_CALL_STATES,
  WEBHOOK_HOOK_ID_PATTERN
} from './connector-webhook-contract'

const HookId = z.string().regex(WEBHOOK_HOOK_ID_PATTERN)
const CallId = z.string().regex(WEBHOOK_CALL_ID_PATTERN)
const CallState = z.enum(WEBHOOK_CALL_STATES)

/** A hook as every route answering one returns it; never a key. */
export const WebhookView = z.object({
  hookId: HookId,
  automationId: z.string().min(1),
  botId: z.string().min(1),
  state: z.enum(['pending', 'live', 'paused', 'orphaned']),
  epoch: z.number().int().nonnegative(),
  // Always 1; sent for older Orca, unread here.
  hostGen: z.number().int().nonnegative().optional(),
  keyGeneration: z.number().int().nonnegative(),
  /** Without the key. */
  url: z.string().url(),
  adapter: z.enum(WEBHOOK_ADAPTERS).nullable(),
  previousKeyExpiresAt: z.number().nullable(),
  lastCall: z.object({ at: z.number(), state: CallState, signatureValid: z.boolean() }).nullable(),
  pendingCalls: z.number().int().nonnegative()
})
export type WebhookView = z.infer<typeof WebhookView>

export const WebhookCallRow = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('call'),
    callId: CallId,
    receivedAt: z.number(),
    state: CallState,
    sample: z.literal(true).optional(),
    runId: z.string().optional(),
    reason: z.string().optional()
  }),
  z.object({
    kind: z.enum(['refused', 'over_budget', 'duplicate']),
    minute: z.number(),
    count: z.number().int().positive()
  })
])
export const WebhookCalls = z.object({ calls: z.array(WebhookCallRow) })
export const WebhookRevealed = z.object({ key: z.string().min(1) })
export const WebhookRotated = z.object({ cancelledCalls: z.number().int().nonnegative() })
// Only a secret Orca generates comes back, for the owner to paste into the sender.
export const WebhookSecretSet = z.object({ secret: z.string().min(1).optional() })
export const WebhookSampleSent = z.object({ callId: CallId })

const ENVELOPE_HEADER_VALUE_LENGTH = 1024

/** A call with the hook's key scrubbed out; truncated when the cloud kept only the start of its body. */
export const WebhookEnvelope = z.object({
  receivedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contentType: z.string().max(ENVELOPE_HEADER_VALUE_LENGTH).nullable(),
  headers: z.record(z.string(), z.string().max(ENVELOPE_HEADER_VALUE_LENGTH)),
  body: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('json'), value: z.unknown() }),
    // Repeated keys become arrays.
    z.object({
      kind: z.literal('form'),
      value: z.record(z.string(), z.union([z.string(), z.array(z.string())]))
    }),
    z.object({ kind: z.literal('text'), value: z.string() })
  ]),
  truncated: z.boolean()
})

export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>
