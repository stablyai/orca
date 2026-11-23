import type { NativeChatAgent } from '../agent-launch/permissions/agent-chat-permission-support'

/** Where a connector conversation comes from. */
export const CONNECTOR_SOURCES = ['slack', 'github', 'linear', 'discord'] as const
export type ConnectorSource = (typeof CONNECTOR_SOURCES)[number]

/** How agent-facing text names where a conversation comes from. */
export const CONNECTOR_SOURCE_NAMES: Record<ConnectorSource, string> = {
  slack: 'Slack',
  github: 'GitHub',
  linear: 'Linear',
  discord: 'Discord'
}

/** Where a conversation's replies land, as a bot reads it: "the Slack thread in #orca", "ENG-42 on Linear". */
export function conversationPlaceText(link: { source: ConnectorSource; place?: string }): string {
  const source = CONNECTOR_SOURCE_NAMES[link.source]
  if (!link.place) {
    return `the ${source} conversation that woke you`
  }
  return link.source === 'slack' || link.source === 'discord'
    ? `the ${source} thread in ${link.place}`
    : `${link.place} on ${source}`
}

/** The conversation a chat is bound to, and whether its answer to one piece of mail lands there. */
export type ChatMailPlace = { place: string; answersThere: boolean }

/** A bot's home a conversation runs in: its own chat for a thread (`bot`), or the bot's Chat (`bot-chat`). */
export type ExternalConversationBot = { kind: 'bot' | 'bot-chat'; botId: string }

/** Who began a chat's turn: its conversation, or someone in Orca (typing, other chats' mail, automations). */
export type ExternalConversationTurnSource = 'conversation' | 'orca'

export type ExternalConversationOpener = {
  role: 'owner' | 'member'
  /** Their name in the source, for "Sam's DM"; attacker-controlled, shown as text only. */
  name?: string
  /** A direct message with the bot, as opposed to a channel thread. */
  dm?: true
}

export const SLACK_MIRROR_BLOCKS = ['thread_unavailable', 'not_in_channel'] as const
export type SlackMirrorBlocked = (typeof SLACK_MIRROR_BLOCKS)[number]

export const SLACK_MIRROR_POST_STATES = ['posting', 'posted', 'failed'] as const
/** One Orca-typed message's post to its Slack thread. `error`: why a failed one failed, as the
 *  cloud said (connector-slack-mirror-contract's SLACK_MIRROR_ERRORS) or the desktop's own. */
export type SlackMirrorPost = {
  state: (typeof SLACK_MIRROR_POST_STATES)[number]
  at: number
  error?: string
}

export type SlackMirrorHeld = { event: unknown; waiting: string[] }

/** An outside thread's native chat, persisted on the workspace it runs in (system-owned). */
export type ExternalConversationLink = {
  source: ConnectorSource
  externalId: string
  sessionId: string
  agent: NativeChatAgent
  /** The chat's status row pane key, derived from `sessionId`. */
  paneKey: string
  /** Set for a bot's conversation, so every delivery checks the bot and a DM reaches its current Chat. */
  bot?: ExternalConversationBot
  /** The row title, from the message that started it; absent on links an older Orca wrote. */
  title?: string
  /** Where it is, as people name it ("#orca", "orca#3412", "ENG-42"); absent until named and from older hosts. */
  place?: string
  /** Whether its chat's latest turn was its conversation's, as the conversation was told; absent until one starts. */
  lastTurn?: ExternalConversationTurnSource
  /** The opening message of the running turn the conversation adopted to show its prompt, though it
   *  didn't ask for that turn; kept so a restarted watch still tells only its state, never its words.
   *  Cleared at that turn's end. */
  adoptedTurn?: { itemId: string; at: number }
  /** Run ids (the provider call that started each run) of background work its conversation's own
   *  turns started that still runs: a turn only their notifications wake answers the conversation
   *  too. Main-process data: clients ignore it. */
  wakeAnswers?: { runs: string[] }
  /** When someone in Orca last steered a message into the chat's running turn: that turn's runs are
   *  theirs, never the conversation's. Main-process data: clients ignore it. */
  orcaJoinedAt?: number
  /** Who began the conversation, as its first delivery said; absent on links an older Orca wrote. */
  opener?: ExternalConversationOpener
  /** Slack only: whether the owner's Orca-typed messages, and the bot's replies to them, post to the
   *  thread too. Absent is off, as on chats from before it. */
  mirror?: boolean
  /** Why the thread takes no more posts, from Slack's answer to the last one. */
  mirrorBlocked?: SlackMirrorBlocked
  /** The owner's messages posted to the thread (or trying), by journal item id; newest kept. */
  mirrorPosts?: Record<string, SlackMirrorPost>
  /** The owner set the switch, so no default (Slack Connect included) changes it again. */
  mirrorChosen?: true
  /** People outside the workspace are in the channel (Slack Connect), as the cloud last said. */
  mirrorExternal?: boolean
  /** Turn ends whose reply waits for the owner's posts (by item id) to post or be dismissed; kept
   *  so a restart still posts them. Main-process data: clients ignore it. */
  mirrorHeld?: SlackMirrorHeld[]
  /** When the owner first opened a bot thread's chat; null until then. Absent on links an older Orca
   *  wrote and on non-bot links, which count as seen. */
  seenAt?: number | null
  createdAt: number
}
