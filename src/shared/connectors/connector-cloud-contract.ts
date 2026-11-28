import type { ConnectorTurnActivity } from './connector-turn-activity-contract'
// Mirror of cloud/packages/connector-contract/src for the machine side of the Orca Cloud connector.
// Copies, not imports: the CLI compiles src/shared with rootDir src, so it can't reach cloud files.
import type { ConnectorPrompt } from '../connector-prompt-contract'
export * from '../connector-prompt-contract'
export * from './connector-failure-contract'
import type { ConnectorFailure } from './connector-failure-contract'
import type { ConnectorWebhookTrigger } from '../connector-webhook-contract'
import type { ConnectorWorkLink } from '../connector-work-link-contract'
import type { AutomationConnectorEventTrigger } from '../automation-event-triggers'
import type { JournalConnectorReplyOutcome } from '../agent-session/journal/journal-connector-reply'
import type { ConnectorActsFor, ConnectorConversation } from './connector-cloud-schemas'

export {
  CONNECTOR_CLOUD_SOURCES,
  ConnectorErrorResponse,
  ConnectorHelloResponse,
  ConnectorConversation,
  ConnectorActsFor,
  cloudConversation,
  ConnectorDelivery,
  ConnectorDeliveryId,
  ConnectorPollResponse,
  ConnectorReplyResponse,
  ConnectorBotPostResponse,
  ConnectorPollControl,
  type ConnectorThreadOwner,
  type ConnectorBotPostAnswer
} from './connector-cloud-schemas'

export const CONNECTOR_CONTRACT_VERSION = 1

export { CONNECTOR_PATHS } from './connector-cloud-paths'

/** The services a person connects in one browser trip (connect-messages.ts in the cloud contract;
 *  connector-mirrored-constants.test.ts keeps them equal). */
export const CONNECTOR_CONNECT_SOURCES = ['linear', 'github', 'slack'] as const
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

export { CONNECTOR_CLIENT_LIMITS } from './connector-client-limits'

// Each hello gets a revision above every earlier one for this machine; polls, acks and events carry it.
// features: what this cloud takes beyond the contract version.
export {
  CONNECTOR_CLOUD_FEATURES,
  CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE,
  CONNECTOR_REPLIES_OUTBOX_FEATURE,
  CONNECTOR_RESUME_FEATURE,
  type ConnectorCloudFeature
} from '../connector-cloud-features'

/** A send whose chat is deleted here; a cloud with threads.owner frees the thread and starts anew. */
export const CHAT_GONE_REFUSAL = 'chat_gone'

/** A resume whose chat's newest turn no longer failed (resumed, answered or replaced since). */
export const NOT_FAILED_REFUSAL = 'not_failed'

export {
  CONNECTOR_ASKER_PLACE_KINDS,
  type ConnectorAskerPlaceKind,
  type ConnectorContextItem,
  type ConnectorAsker,
  ConnectorAskerVia,
  type ConnectorEarlierOwn
} from '../connector-asker-contract'

/** Whom a bot's turn acts for when no delivery started it: someone_else keeps its Slack posts from
 *  counting as the owner's; none (a post for a chat other than the calling one) from counting as
 *  anyone's. */
export type ConnectorTurnFor = 'owner' | 'someone_else' | 'none'

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
      /** A no_answer turn that ran a tool call that may have acted; an older cloud ignores it. */
      toolsRan?: true
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
