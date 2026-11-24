// The agents other people shared with this Orca account, as main publishes them to the window: each is
// a host the app reaches over Orca Relay by its own environment id.

export type SharedBotHostLink = 'live' | 'connecting' | 'offline' | 'unpaired'

/** A held message as Orca Cloud last reported it: waiting for the host, in its journal, or refused. */
export type SharedBotHeldState = 'waiting' | 'delivered' | 'not_sent'

export type SharedBotHostView = {
  environmentId: string
  shareId: string
  botId: string
  botName: string
  /** Who shared it: their name, else their email, else their computer's name. */
  ownerName: string
  link: SharedBotHostLink
}

/** Refusals a shared host's call answers with when it didn't reach the host. */
export const SHARED_BOT_HOST_ERRORS = {
  // The host can't be reached and nothing was held for it.
  offline: 'shared_host_offline',
  // The message is held in Orca Cloud until the host is back.
  held: 'shared_host_send_held',
  // Past the cloud's limit for one held message.
  tooLarge: 'shared_host_send_too_large'
} as const
