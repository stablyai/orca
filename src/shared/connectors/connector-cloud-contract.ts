import { ConnectorAnswerFields } from '../connector-prompt-contract'
import type { ConnectorTurnActivity } from './connector-turn-activity-contract'
// Mirror of cloud/packages/connector-contract/src for the machine side of the Orca Cloud connector.
// Copies, not imports: the CLI compiles src/shared with rootDir src, so it can't reach cloud files.
import * as z from 'zod'
import type { ConnectorPrompt } from '../connector-prompt-contract'
export * from '../connector-prompt-contract'
export * from './connector-failure-contract'
import type { ConnectorFailure } from './connector-failure-contract'
import {
  ConnectorTriggerEvent,
  ConnectorTurnAutomation,
  isTriggerFromItsSource
} from '../connector-trigger-event-contract'
import { WebhookNotice, type ConnectorWebhookTrigger } from '../connector-webhook-contract'
import { PrEvent } from '../connector-pr-event-contract'
import { ConnectorAsker } from '../connector-asker-contract'
import type { ConnectorWorkLink } from '../connector-work-link-contract'
import type { AutomationConnectorEventTrigger } from '../automation-event-triggers'
import type { JournalConnectorReplyOutcome } from '../agent-session/journal/journal-connector-reply'

export const CONNECTOR_CONTRACT_VERSION = 1

export { CONNECTOR_PATHS } from './connector-cloud-paths'

/** The shared-app services an owner connects in one browser trip. */
export const CONNECTOR_CONNECT_SOURCES = ['linear', 'github'] as const
export type ConnectorConnectSource = (typeof CONNECTOR_CONNECT_SOURCES)[number]

export const CONNECTOR_FEATURES = [
  'answer',
  'cancel',
  'reply',
  'turnCancel',
  'trigger',
  'webhook',
  'triggerInTurn',
  'prEvents',
  'threadCatchUp',
  'batchedSends',
  'ownDmChats',
  'askerNote'
] as const

export const CONNECTOR_CLIENT_LIMITS = {
  pollTimeoutMs: 70_000,
  minDeadlineLeftMs: 10_000,
  maxLastAssistantMessageBytes: 8 * 1024,
  // One reply event's deliveries.
  maxReplyDeliveryIds: 100,
  // The cloud refuses a larger request body with 413.
  maxRequestBytes: 1024 * 1024,
  // One event's JSON, so any single event fits in an events request.
  maxEventBytes: 192 * 1024,
  // A snapshot lists linked conversations active in the last 7 days, newest first, up to this many.
  maxSnapshotConversations: 200,
  snapshotActiveWindowMs: 7 * 24 * 60 * 60 * 1000,
  maxDisplayTextLength: 200,
  // A hello (or one bot page) lists at most this many bots, each with at most maxBotMembers member ids.
  maxHelloBots: 20,
  // Pages of maxHelloBots bots a hello may name, to a cloud listing `bots.pages`.
  maxBotPages: 100,
  maxBotIdLength: 128,
  maxBotMembers: 200,
  maxBotMemberIdLength: 32,
  maxBotWorkspaceMemberIdLength: 64,
  maxBotWorkspaceMembers: 50,
  maxBotHandleLength: 64,
  // A reply's inline review notes.
  maxReviewComments: 30,
  maxReviewPathLength: 256,
  maxReviewCommentChars: 1_000,
  // One per Linear workspace or GitHub installation.
  maxBotWorkspaces: 8,
  // Slack's rows beside those, from a cloud with `slack.teams`: together at most maxBotMembers people.
  maxBotSlackWorkspaces: 8,
  // A hello lists at most this many event rules of bot automations.
  maxHelloTriggers: 100
} as const

// Machine-side readers: they keep what this Orca uses and ignore fields a newer cloud adds.
export const ConnectorErrorResponse = z.object({ error: z.string().min(1) })

// Each hello gets a revision above every earlier one for this machine; polls, acks and events carry it.
// features: what this cloud takes beyond the contract version.
export {
  CONNECTOR_CLOUD_FEATURES,
  CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE,
  CONNECTOR_REPLIES_OUTBOX_FEATURE,
  type ConnectorCloudFeature
} from '../connector-cloud-features'
export const ConnectorHelloResponse = z.object({
  helloRev: z.number().int().positive(),
  features: z.array(z.string()).optional(),
  webhookTombstones: z.array(z.string()).optional().catch(undefined)
})

/** Where an Orca Cloud conversation comes from. */
export const CONNECTOR_CLOUD_SOURCES = ['slack', 'discord', 'linear', 'github', 'webhook'] as const

/** A thread; a webhook has none, only its calls' trigger deliveries. */
export const ConnectorConversation = z.object({
  source: z.enum(CONNECTOR_CLOUD_SOURCES).exclude(['webhook']),
  externalId: z.string().min(1)
})
export type ConnectorConversation = z.infer<typeof ConnectorConversation>

/** Whom a bot's chat acts for, as its thread row keeps it: the owner, one member, or anyone. */
export const ConnectorActsFor = z.union([
  z.literal('owner'),
  z.literal('anyone'),
  z.string().regex(/^member:\S{1,128}$/)
])
export type ConnectorActsFor = z.infer<typeof ConnectorActsFor>

/** The chat that owns an event's thread, and whom it acts for (null: not recorded). */
const ConnectorThreadOwner = z.object({
  conversation: ConnectorConversation,
  actsFor: ConnectorActsFor.nullable()
})
export type ConnectorThreadOwner = z.infer<typeof ConnectorThreadOwner>

/** A send whose chat is deleted here; a cloud with threads.owner frees the thread and starts anew. */
export const CHAT_GONE_REFUSAL = 'chat_gone'

/** The conversation as Orca Cloud names it; null for one the cloud's contract can't name. */
export function cloudConversation(key: {
  source: string
  externalId: string
}): ConnectorConversation | null {
  const parsed = ConnectorConversation.safeParse(key)
  return parsed.success ? parsed.data : null
}

export {
  CONNECTOR_ASKER_PLACE_KINDS,
  type ConnectorAskerPlaceKind,
  type ConnectorContextItem,
  type ConnectorAsker,
  ConnectorAskerVia,
  type ConnectorEarlierOwn
} from '../connector-asker-contract'

// A shape this build can't read drops the facts, never the delivery: it then reads prompt or text.
const OptionalAsker = ConnectorAsker.optional().catch(undefined)

const OptionalTurnAutomations = z.array(ConnectorTurnAutomation).optional().catch(undefined)

// When the cloud took the person's message (epoch ms, the cloud's clock); absent from an older cloud.
const OptionalAskedAt = z.number().int().positive().optional().catch(undefined)

const DeliveryBase = {
  deliveryId: z.string().min(1),
  expiresAt: z.number().int().positive(),
  conversation: ConnectorConversation
}

export const ConnectorDelivery = z.discriminatedUnion('kind', [
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
    // A mention of the bot with no words of its own; its text is the cloud's stand-in.
    bareMention: z.literal(true).optional(),
    askedAt: OptionalAskedAt
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
export type ConnectorDelivery = z.infer<typeof ConnectorDelivery>

/** Enough of a delivery this Orca cannot read to settle it as unsupported. */
export const ConnectorDeliveryId = z.object({ deliveryId: z.string().min(1) })

const Unsettled = z.object({ deliveryId: z.string().min(1), conversation: ConnectorConversation })

// Each delivery, unsettled entry and the control are read one by one, so one this Orca cannot read
// never drops the rest.
export const ConnectorPollResponse = z.object({
  serverNow: z.number().int().positive(),
  holdMs: z.number().int().nonnegative(),
  unsettled: z
    .array(z.unknown())
    .transform((entries) => entries.flatMap((entry) => Unsettled.safeParse(entry).data ?? []))
    .optional(),
  deliveries: z.array(z.unknown()),
  control: z.unknown().optional()
})

// notices: why the reply can't wake an Orca bot it mentions.
const PostNotices = z.array(z.string()).optional().catch(undefined)
export const ConnectorReplyResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('posted'), messageId: z.string().min(1), notices: PostNotices }),
  z.object({ status: z.literal('queued'), notices: PostNotices })
])

/** Whom a bot's turn acts for when no delivery started it: someone_else keeps its Slack posts from
 *  counting as the owner's; none (a post for a chat other than the calling one) from counting as
 *  anyone's. */
export type ConnectorTurnFor = 'owner' | 'someone_else' | 'none'
export type ConnectorReplyResponse = z.infer<typeof ConnectorReplyResponse>

// A bot post answers 204 with no body, or, to a machine that says whom it acts for, why it can't
// wake the Orca bots it mentions.
export const ConnectorBotPostResponse = z.union([
  z.undefined(),
  z.object({ notices: z.array(z.string()).optional() })
])
export type ConnectorBotPostAnswer = z.infer<typeof ConnectorBotPostResponse>

export const ConnectorPollControl = z.union([
  z.object({ stop: z.string().min(1) }),
  z.object({ pausedForMs: z.number().int().positive() }),
  z.object({ reconnect: z.literal(true) })
])
export type ConnectorPollControl = z.infer<typeof ConnectorPollControl>

/** A bot this machine hosts; its places are `['bot', id]` (one chat per thread) and `['bot-chat', id]` (its Chat). */
export type ConnectorBot = {
  id: string
  name: string
  agent: string
  /** The Slack user ids the owner lets ask the bot. */
  members: string[]
  paused: boolean
  /** How people name it where bots share one app: "@Orca reviewer", label `bot:reviewer`. */
  handle?: string
  /** Workspaces of a shared-app source (Linear, GitHub installations) it answers in, with who may ask there. */
  sharedAppWorkspaces?: ConnectorBotWorkspace[]
}

/** One event rule of a bot automation here; the cloud sends a match to this machine alone. */
export type ConnectorTrigger = ConnectorEventTrigger | ConnectorWebhookTrigger

/** The rule's id and filters as the automation keeps them, without its display names. */
export type ConnectorEventTrigger = Omit<
  AutomationConnectorEventTrigger,
  'source' | 'event' | 'names'
> & {
  automationId: string
  botId: string
  source: ConnectorConversation['source']
  event: string
  /** The automation's missed-run grace: how long an event may wait for this machine. */
  graceMinutes: number
  /** Its run answers in the event's thread, so the cloud binds the run's conversation there. */
  inThread?: true
}

export type ConnectorBotWorkspace = {
  source: ConnectorConversation['source']
  workspaceId: string
  members: string[]
}

export type ConnectorDeliveryResult =
  | { outcome: 'accepted'; reopened?: true; inTurn?: true }
  | { outcome: 'refused'; reason: string; failure?: ConnectorFailure }
  | { outcome: 'unknown'; reason: string }
  | { outcome: 'expired' | 'unsupported' }

export type ConnectorAck =
  | { deliveryId: string; step: 'received' }
  | { deliveryId: string; step: 'done'; result: ConnectorDeliveryResult }

type PaneEvent = { conversation: ConnectorConversation; paneKey: string }

/** A chat turn's cause: a connector delivery, or someone typing in Orca (not mirrored back). */
export const CONNECTOR_TURN_ORIGINS = ['delivery', 'local'] as const
export type ConnectorTurnOrigin = (typeof CONNECTOR_TURN_ORIGINS)[number]

export type ConnectorEvent =
  | (PaneEvent & { kind: 'linked'; agent: string; actsFor?: ConnectorActsFor })
  /** Only to a cloud that lists `threads.owner`. */
  | (PaneEvent & { kind: 'acts-for'; actsFor: ConnectorActsFor })
  | (PaneEvent & { kind: 'unlinked' })
  | (PaneEvent & {
      kind: 'prompt'
      prompt: ConnectorPrompt
      /** Answered in Orca; a connector that predates it reads the prompt as still shown, as before. */
      answered?: true
      answeredWith?: string
    })
  // deliveryId: the delivery the turn answers; an older cloud ignores it.
  | (PaneEvent & { kind: 'turn-started'; at: number; deliveryId?: string })
  | (PaneEvent & {
      kind: 'turn-ended'
      turnId: number
      at: number
      stopReason: string | null
      lastAssistantMessage?: string
      /** Chats only; terminal turns omit it. */
      origin?: ConnectorTurnOrigin
      /** Why a failed chat turn failed. */
      failure?: ConnectorFailure
      /** Its conversation's bot work's pull requests; a cloud that doesn't read them drops them. */
      links?: ConnectorWorkLink[]
      /** An Orca-typed turn of a chat posting to Slack: its reply posts too (`slack.mirror`). */
      mirror?: true
      /** Whom the turn acts for when no delivery started it; an older cloud ignores it. */
      turnFor?: ConnectorTurnFor
      /** The thread's turn state only; its answer goes through the reply outbox. */
      stateOnly?: true
      /** With a usage-limit reset this machine resumes at; only to a cloud listing `replies.paused`. */
      resumes?: true
    })
  /** Only to a cloud that lists `replies.outbox`: the outcome of the admitted deliveries one turn
   *  answered in one conversation, keyed by answerDeliveryId (one of deliveryIds). */
  | ({
      kind: 'reply'
      conversation: ConnectorConversation
      deliveryIds: string[]
      answerDeliveryId: string
      outcome: JournalConnectorReplyOutcome
      prose?: string
      failure?: ConnectorFailure
      links?: ConnectorWorkLink[]
      turnId?: number
    } & { /** How long an answered turn ran. */ tookMs?: number })
  /** Whether workers its agent started still run; only to a cloud that lists `workers`. */
  | (PaneEvent & { kind: 'workers'; running: boolean })
  /** Only to a cloud that lists `turn.activity`. */
  | (PaneEvent & ConnectorTurnActivity)
  | {
      kind: 'snapshot'
      conversations: (PaneEvent & {
        agent: string
        working: boolean
        prompt: ConnectorPrompt | null
        // The pane's latest turn; a turn end older than it changes nothing.
        turnId?: number
        /** Absent while this Orca hasn't read them yet. */
        workersRunning?: boolean
      })[]
    }
