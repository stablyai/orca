// Mirror of cloud/packages/connector-contract/src/webhook-{names,matcher,messages}.ts for the machine
// side; both test suites check the shared JSON contract corpus.
// Copies, not imports: the CLI compiles src/shared with rootDir src, so it can't reach cloud files.
import * as z from 'zod'
import { lazyZodSchema } from './schema/lazy-zod-schema'

export const WEBHOOK_HOOK_ID_PATTERN = /^wh_[A-Za-z0-9]{16}$/
export const WEBHOOK_CALL_ID_PATTERN = /^call_[A-Za-z0-9]{20}$/

const RULE_ID_PREFIX = 'wh-'
const ACTOR_ID_PREFIX = 'webhook:'

function hookIdAfter(prefix: string, id: string): string | null {
  const hookId = id.startsWith(prefix) ? id.slice(prefix.length) : ''
  return WEBHOOK_HOOK_ID_PATTERN.test(hookId) ? hookId : null
}

export function webhookRuleId(hookId: string): string {
  return `${RULE_ID_PREFIX}${hookId}`
}

/** The hook a rule id names, or null for any other rule. */
export function hookIdOfRule(ruleId: string): string | null {
  return hookIdAfter(RULE_ID_PREFIX, ruleId)
}

export function webhookActorId(hookId: string): string {
  return `${ACTOR_ID_PREFIX}${hookId}`
}

/** The hook a trigger event's actor names, or null for a person. */
export function hookIdOfActor(actorId: string): string | null {
  return hookIdAfter(ACTOR_ID_PREFIX, actorId)
}

/**
 * Runs started per exact rolling hour: a hook's own cap (the owner may set 1 up to the default), and
 * its account's, of which one hook takes at most 2/3.
 */
export const WEBHOOK_RUN_CAPS = { hookDefault: 200, account: 300 } as const

export const WEBHOOK_ADAPTERS = [
  'standard',
  'github',
  'sentry',
  'linear',
  'pagerduty',
  'stripe'
] as const
export type WebhookAdapterId = (typeof WEBHOOK_ADAPTERS)[number]

export const WEBHOOK_CALL_STATES = [
  'queued',
  'ignored',
  'paused',
  'delivered',
  'cancelled',
  'waiting_capacity',
  'started',
  'folded',
  'refused',
  'missed',
  'unavailable',
  'completed',
  'failed',
  'unverifiable'
] as const
export type WebhookCallState = (typeof WEBHOOK_CALL_STATES)[number]

export const WEBHOOK_FILTER_LIMITS = {
  maxWhere: 8,
  maxValues: 10,
  maxPick: 12,
  maxPathLength: 200,
  maxValueLength: 200,
  maxSubjectLength: 256,
  maxRuleBytes: 2560
} as const

export const WEBHOOK_WHERE_OPS = ['=', '!=', 'in', 'contains', 'exists', '!exists'] as const
export type WebhookWhereOp = (typeof WEBHOOK_WHERE_OPS)[number]
export type WebhookWhere = { path: string; op: WebhookWhereOp; values?: string[] }
export type WebhookFilters = {
  where?: WebhookWhere[]
  textContains?: string
  pick?: string[]
  subjectFrom?: string
  subject?: string
}

/** A hook's rule as this machine lists it in a hello: id webhookRuleId(hookId), one per automation. */
export type ConnectorWebhookTrigger = WebhookFilters & {
  id: string
  automationId: string
  botId: string
  source: 'webhook'
  event: 'call'
  /** Raised on each filter edit; the id, and so the URL, stays. */
  rev: number
  graceMinutes: number
}

/** On a trigger delivery from a hook. */
export const WebhookCallFields = lazyZodSchema(() =>
  z.object({
    callId: z.string().regex(WEBHOOK_CALL_ID_PATTERN),
    /** The hook's lifecycle generation at admission; this machine refuses one below its own. */
    epoch: z.number().int().nonnegative(),
    // Always 1; sent for older Orca, unread here.
    hostGen: z.number().int().nonnegative().optional(),
    sample: z.literal(true).optional()
  })
)
export type WebhookCallFields = z.infer<typeof WebhookCallFields>

export const WEBHOOK_NOTICE_CONDITIONS = ['refusal_burst', 'cap_reached'] as const
export type WebhookNoticeCondition = (typeof WEBHOOK_NOTICE_CONDITIONS)[number]

export const WebhookNotice = lazyZodSchema(() =>
  z.object({
    kind: z.literal('webhook_notice'),
    hookId: z.string().regex(WEBHOOK_HOOK_ID_PATTERN),
    botId: z.string().min(1),
    condition: z.enum(WEBHOOK_NOTICE_CONDITIONS),
    count: z.number().int().nonnegative(),
    at: z.number().int().nonnegative()
  })
)

const RunId = z.string().min(1).max(200)

// The answers to POST /v1/connector/webhook-calls/:callId/start; one grant per call, bound to its run.
export const WebhookCallStartAnswer = lazyZodSchema(() =>
  z.discriminatedUnion('started', [
    z.object({ started: z.literal(true), runId: RunId.optional() }),
    z.object({ started: z.literal(false), retryAt: z.number() })
  ])
)
// 409 names the run that already holds the grant; 410 means the call can never start again.
export const WebhookCallStartConflict = lazyZodSchema(() =>
  z.object({
    error: z.literal('started_for_another_run'),
    runId: RunId
  })
)
export const WebhookCallStartSettled = lazyZodSchema(() =>
  z.object({ error: z.literal('settled') })
)

const absent = lazyZodSchema(() => z.never().optional())

/** A hook's call: keyed by its callId, done by its hook, with no text or display string to leak a key. */
export const WebhookTriggerEvent = lazyZodSchema(() =>
  z
    .object({
      key: z.string().regex(WEBHOOK_CALL_ID_PATTERN),
      actorId: z.string().refine((id) => hookIdOfActor(id) !== null),
      subject: z.string().min(1).optional(),
      occurredAt: z.number().int().nonnegative(),
      webhook: WebhookCallFields,
      fromOwner: absent,
      onOwnerMessage: absent,
      pr: absent,
      actor: absent,
      place: absent,
      url: absent,
      text: absent
    })
    .refine(({ key, webhook }) => key === webhook.callId)
)

/** A rule's size in a hello: its serialized UTF-8 JSON. */
export function webhookRuleBytes(rule: ConnectorWebhookTrigger): number {
  return new TextEncoder().encode(JSON.stringify(rule)).length
}
