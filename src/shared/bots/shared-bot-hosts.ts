// The agents other people shared with this Orca account, as main publishes them to the window: each is
// a host the app reaches over Orca Relay by its own environment id.

export type SharedBotHostLink = 'live' | 'connecting' | 'offline' | 'unpaired'

/** Off for now: a shared host that is away reads as a paired server that is away (no send, nothing
 *  held). Every held path reads this; the held code stays for when it comes back. */
export const SHARED_HOSTS_HOLD_WHILE_AWAY: boolean = false

/** A held message as Orca Cloud last reported it: waiting for the host, in its journal, or refused. */
export type SharedBotHeldState = 'waiting' | 'delivered' | 'not_sent'

export type SharedBotHeldView = {
  clientMessageId: string
  /** The chat it is for: one of theirs, or a new chat's placeholder id until the host starts it. */
  sessionId: string
  text: string
  /** The names of the files sealed with it; their bytes stay in main. */
  attachments: string[]
  sentAt: number
  state: SharedBotHeldState
}

export type SharedBotHostView = {
  environmentId: string
  shareId: string
  botId: string
  botName: string
  /** Who shared it: their name, else their email, else their computer's name. */
  ownerName: string
  /** This computer's folder workspace the agent's chats open in; null until main has made it. */
  homeWorkspaceId: string | null
  link: SharedBotHostLink
  /** Whether a message can be held for the host while it is away (it published its key). */
  holds: boolean
  /** This device's held messages the cloud still reports, oldest first. */
  held: SharedBotHeldView[]
}

/** What main publishes: the shared agents, and whether this account's Orca Cloud takes shares
 *  (its shares route answers); null until it first answers either way. */
export type SharedBotHostsState = {
  hosts: SharedBotHostView[]
  sharing: boolean | null
}

// A new chat started while the host is away: its id until the host starts it from the first held message.
const NEW_CHAT_PREFIX = 'shared-new-'

export function newSharedBotChatId(uuid: string): string {
  return `${NEW_CHAT_PREFIX}${uuid}`
}

export function isSharedBotNewChatId(sessionId: string | undefined): boolean {
  return sessionId?.startsWith(NEW_CHAT_PREFIX) === true
}

/** Refusals a shared host's call answers with when it didn't reach the host. */
export const SHARED_BOT_HOST_ERRORS = {
  // The host can't be reached and nothing was held for it.
  offline: 'shared_host_offline',
  // The message is held in Orca Cloud until the host is back.
  held: 'shared_host_send_held',
  // Past the cloud's limit for one held message.
  tooLarge: 'shared_host_send_too_large',
  // The owner stopped sharing it: nothing is sent or held.
  unshared: 'shared_host_unshared'
} as const
