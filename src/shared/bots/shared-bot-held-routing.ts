// Where a teammate's message to a shared agent goes, the same on their computer and their phone: to the
// host live over the relay, or held in Orca Cloud while the host is away.
import type { SharedHostLink } from '../remote-runtime/relay/client/shared-host-relay-link'
import {
  isSharedBotNewChatId,
  SHARED_BOT_HOST_ERRORS,
  SHARED_HOSTS_HOLD_WHILE_AWAY,
  type SharedBotHeldState
} from './shared-bot-hosts'

/** The chat a held message is for: one of theirs, or a new chat by its placeholder id. */
export type SharedBotHeldChat = { sessionId: string } | { newChatId: string }

/** What routing reads of one held message. */
export type SharedBotHeldRoute = {
  clientMessageId: string
  chat: SharedBotHeldChat
  // A new chat's session once the host started it: the chat the message lands in.
  startedAs?: string
}

/** The chat a held message lands in: its session, a new chat's once the host started it, else its
 *  placeholder id (the namespaces never meet). */
export function sharedBotHeldChatId(held: Pick<SharedBotHeldRoute, 'chat' | 'startedAs'>): string {
  return 'sessionId' in held.chat ? held.chat.sessionId : (held.startedAs ?? held.chat.newChatId)
}

/** The chat a session id names: a placeholder id is a new chat the host hasn't started yet. */
export function sharedBotHeldChat(sessionId: string): SharedBotHeldChat {
  return isSharedBotNewChatId(sessionId) ? { newChatId: sessionId } : { sessionId }
}

/**
 * Whether a message goes to Orca Cloud's held queue instead of the relay. Only with the host's key
 * (no key, nothing can be sealed to it). Then: whenever the host can't be reached live, for a new chat
 * the host hasn't started yet, and while an earlier held message in the same chat hasn't landed, so a
 * later one never overtakes it.
 */
export function sendsHeldTo(
  hostKey: string | undefined,
  held: readonly SharedBotHeldRoute[],
  link: SharedHostLink,
  chat: SharedBotHeldChat,
  heldStates: ReadonlyMap<string, SharedBotHeldState>
): boolean {
  if (!SHARED_HOSTS_HOLD_WHILE_AWAY || !hostKey) {
    return false
  }
  if (link !== 'live' || 'newChatId' in chat) {
    return true
  }
  const chatId = sharedBotHeldChatId({ chat })
  return held.some(
    (message) =>
      sharedBotHeldChatId(message) === chatId &&
      (heldStates.get(message.clientMessageId) ?? 'waiting') === 'waiting'
  )
}

/** How a held send ended, as the device that tried it tells the chat. */
export type SharedBotHoldOutcome = 'held' | 'too-large' | 'unshared' | 'failed'

/** The error code and words a hold answers the send with; null for a failed hold, which reads as
 *  the host being offline. */
export function sharedBotHeldRefusal(
  outcome: SharedBotHoldOutcome,
  ownerName: string
): readonly [code: string, message: string] | null {
  switch (outcome) {
    case 'held':
      return [SHARED_BOT_HOST_ERRORS.held, `Waiting for ${ownerName}’s computer`]
    case 'too-large':
      return [
        SHARED_BOT_HOST_ERRORS.tooLarge,
        `Too large to hold; send it when ${ownerName}’s computer is online`
      ]
    case 'unshared':
      return [SHARED_BOT_HOST_ERRORS.unshared, `${ownerName} no longer shares this agent with you`]
    case 'failed':
      return null
  }
}
