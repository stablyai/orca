import * as z from 'zod'
import { ConnectorAnswerFields } from '../connector-prompt-contract'
import {
  ConnectorTriggerEvent,
  ConnectorTurnAutomation,
  isTriggerFromItsSource
} from '../connector-trigger-event-contract'
import { WebhookNotice } from '../connector-webhook-contract'
import { PrEvent } from '../connector-pr-event-contract'
import { ConnectorAsker } from '../connector-asker-contract'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

// Machine-side readers: they keep what this Orca uses and ignore fields a newer cloud adds.
export const ConnectorErrorResponse = lazyZodSchema(() => z.object({ error: z.string().min(1) }))

export const ConnectorHelloResponse = lazyZodSchema(() =>
  z.object({
    helloRev: z.number().int().positive(),
    features: z.array(z.string()).optional(),
    webhookTombstones: z.array(z.string()).optional().catch(undefined)
  })
)

/** Where an Orca Cloud conversation comes from. */
export const CONNECTOR_CLOUD_SOURCES = ['slack', 'discord', 'linear', 'github', 'webhook'] as const

/** A thread; a webhook has none, only its calls' trigger deliveries. */
export const ConnectorConversation = lazyZodSchema(() =>
  z.object({
    source: z.enum(CONNECTOR_CLOUD_SOURCES).exclude(['webhook']),
    externalId: z.string().min(1)
  })
)
export type ConnectorConversation = z.infer<typeof ConnectorConversation>

/** Whom a bot's chat acts for, as its thread row keeps it: the owner, one member, or anyone. */
export const ConnectorActsFor = lazyZodSchema(() =>
  z.union([z.literal('owner'), z.literal('anyone'), z.string().regex(/^member:\S{1,128}$/)])
)
export type ConnectorActsFor = z.infer<typeof ConnectorActsFor>

/** The chat that owns an event's thread, and whom it acts for (null: not recorded). */
const ConnectorThreadOwner = lazyZodSchema(() =>
  z.object({
    conversation: ConnectorConversation,
    actsFor: ConnectorActsFor.nullable()
  })
)
export type ConnectorThreadOwner = z.infer<typeof ConnectorThreadOwner>

/** The conversation as Orca Cloud names it; null for one the cloud's contract can't name. */
export function cloudConversation(key: {
  source: string
  externalId: string
}): ConnectorConversation | null {
  const parsed = ConnectorConversation.safeParse(key)
  return parsed.success ? parsed.data : null
}

// A shape this build can't read drops the facts, never the delivery: it then reads prompt or text.
const OptionalAsker = lazyZodSchema(() => ConnectorAsker.optional().catch(undefined))

const OptionalTurnAutomations = lazyZodSchema(() =>
  z.array(ConnectorTurnAutomation).optional().catch(undefined)
)

// When the cloud took the person's message (epoch ms, the cloud's clock); absent from an older cloud.
const OptionalAskedAt = lazyZodSchema(() => z.number().int().positive().optional().catch(undefined))

const createDeliveryBase = () => ({
  deliveryId: z.string().min(1),
  expiresAt: z.number().int().positive(),
  conversation: ConnectorConversation
})

export const ConnectorDelivery = lazyZodSchema(() => {
  const DeliveryBase = createDeliveryBase()
  return z.discriminatedUnion('kind', [
    z.object({
      ...DeliveryBase,
      kind: z.literal('start'),
      agent: z.string().min(1),
      placeId: z.string().min(1),
      prompt: z.string().min(1),
      asker: OptionalAsker,
      automations: OptionalTurnAutomations,
      // A mention of the bot with no words of its own; its text is the cloud's stand-in.
      bareMention: z.literal(true).optional(),
      askedAt: OptionalAskedAt
    }),
    z.object({
      ...DeliveryBase,
      kind: z.literal('send'),
      text: z.string().min(1),
      asker: OptionalAsker,
      automations: OptionalTurnAutomations,
      // The reply @mentioned the bot, which unmutes a muted thread; absent from an older cloud.
      mentioned: z.literal(true).optional().catch(undefined),
      // A mention of the bot with no words of its own; its text is the cloud's stand-in.
      bareMention: z.literal(true).optional(),
      askedAt: OptionalAskedAt,
      // Resume pressed on the failed turn turnId: continue the chat only while that is still so.
      resume: z.object({ turnId: z.number().int().positive() }).optional()
    }),
    z
      .object({
        ...DeliveryBase,
        kind: z.literal('answer'),
        ...ConnectorAnswerFields
      })
      .refine((answer) => (answer.optionId === undefined) !== (answer.text === undefined)),
    // A Stop names the turn it was pressed for (its turn-started `at`).
    z.object({
      ...DeliveryBase,
      kind: z.literal('cancel'),
      turnId: z.number().int().positive().optional()
    }),
    // A matched event for one of this machine's bot automations; its conversation is the event's own.
    z
      .object({
        ...DeliveryBase,
        conversation: ConnectorConversation.extend({ source: z.enum(CONNECTOR_CLOUD_SOURCES) }),
        kind: z.literal('trigger'),
        automationId: z.string().min(1),
        triggerId: z.string().min(1),
        botId: z.string().min(1),
        // The cloud bound its conversation to the event's thread; absent from an older cloud.
        inThread: z.literal(true).optional(),
        // The chat that owns that thread; absent from an older cloud, or a thread no chat owns.
        owner: ConnectorThreadOwner.optional().catch(undefined),
        event: ConnectorTriggerEvent
      })
      .refine(isTriggerFromItsSource),
    WebhookNotice.extend({
      ...DeliveryBase,
      conversation: ConnectorConversation.extend({ source: z.enum(CONNECTOR_CLOUD_SOURCES) })
    }),
    // An event on a pull request this machine's bots' owner opened; its conversation is the PR's own.
    z.object({
      ...DeliveryBase,
      kind: z.literal('pr_event'),
      event: PrEvent
    })
  ])
})
export type ConnectorDelivery = z.infer<typeof ConnectorDelivery>

/** Enough of a delivery this Orca cannot read to settle it as unsupported. */
export const ConnectorDeliveryId = lazyZodSchema(() => z.object({ deliveryId: z.string().min(1) }))

const Unsettled = lazyZodSchema(() =>
  z.object({ deliveryId: z.string().min(1), conversation: ConnectorConversation })
)

// Each delivery, unsettled entry and the control are read one by one, so one this Orca cannot read
// never drops the rest.
export const ConnectorPollResponse = lazyZodSchema(() =>
  z.object({
    serverNow: z.number().int().positive(),
    holdMs: z.number().int().nonnegative(),
    unsettled: z
      .array(z.unknown())
      .transform((entries) => entries.flatMap((entry) => Unsettled.safeParse(entry).data ?? []))
      .optional(),
    deliveries: z.array(z.unknown()),
    control: z.unknown().optional()
  })
)

// notices: why the reply can't wake an Orca bot it mentions.
const PostNotices = lazyZodSchema(() => z.array(z.string()).optional().catch(undefined))
export const ConnectorReplyResponse = lazyZodSchema(() =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('posted'), messageId: z.string().min(1), notices: PostNotices }),
    z.object({ status: z.literal('queued'), notices: PostNotices })
  ])
)
export type ConnectorReplyResponse = z.infer<typeof ConnectorReplyResponse>

// A bot post answers 204 with no body, or, to a machine that says whom it acts for, why it can't
// wake the Orca bots it mentions.
export const ConnectorBotPostResponse = lazyZodSchema(() =>
  z.union([z.undefined(), z.object({ notices: z.array(z.string()).optional() })])
)
export type ConnectorBotPostAnswer = z.infer<typeof ConnectorBotPostResponse>

export const ConnectorPollControl = lazyZodSchema(() =>
  z.union([
    z.object({ stop: z.string().min(1) }),
    z.object({ pausedForMs: z.number().int().positive() }),
    z.object({ reconnect: z.literal(true) })
  ])
)
export type ConnectorPollControl = z.infer<typeof ConnectorPollControl>
