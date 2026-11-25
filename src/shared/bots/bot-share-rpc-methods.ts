// What a teammate's share connection may call: one bot's chats and nothing else on the host. Every
// method names how the share guard admits it, so a method can't be allowed without its check.
import { z } from 'zod'

/** `chat`: the session it names must be one of the teammate's own chats on the shared bot.
 *  `bot`: the bot it names must be the shared bot; its handler lists only the teammate's chats.
 *  `scoped`: names nothing; what it returns comes from `botShareScopedView` alone.
 *  `self`: bound to the caller's own connection (its Relay credential, its own uploads). */
export type BotShareMethodAccess =
  | { kind: 'chat'; sessionId: (params: unknown) => string | undefined }
  | { kind: 'bot'; botId: (params: unknown) => string | undefined }
  | { kind: 'scoped' }
  | { kind: 'self' }

const SessionParams = z.looseObject({ sessionId: z.string() })
const EnvelopeParams = z.looseObject({ envelope: SessionParams })
const BotParams = z.looseObject({ botId: z.string() })

const SESSION: BotShareMethodAccess = {
  kind: 'chat',
  sessionId: (params) => SessionParams.safeParse(params).data?.sessionId
}
const ENVELOPE_SESSION: BotShareMethodAccess = {
  kind: 'chat',
  sessionId: (params) => EnvelopeParams.safeParse(params).data?.envelope.sessionId
}
const BOT: BotShareMethodAccess = {
  kind: 'bot',
  botId: (params) => BotParams.safeParse(params).data?.botId
}

/** The methods that name nothing: each needs its view in `botShareScopedView`, or the build fails. */
export const BOT_SHARE_SCOPED_METHODS = [
  'bots.list',
  'bots.roster',
  'bots.chats.own',
  'agentSession.subscribeStatus',
  'status.get'
] as const
export type BotShareScopedMethod = (typeof BOT_SHARE_SCOPED_METHODS)[number]
const SELF: BotShareMethodAccess = { kind: 'self' }

/** The shared methods that open a stream; every other one answers once. */
export const BOT_SHARE_STREAM_METHODS: ReadonlySet<string> = new Set([
  'agentSession.subscribe',
  'agentSession.subscribeStatus'
])

export const BOT_SHARE_RPC_METHODS: ReadonlyMap<string, BotShareMethodAccess> = new Map<
  string,
  BotShareMethodAccess
>([
  ...BOT_SHARE_SCOPED_METHODS.map((method) => [method, { kind: 'scoped' } as const] as const),
  ['bots.avatar.read', BOT],
  ['bots.chats', BOT],
  ['bots.chatTree', BOT],
  ['bots.session.start', BOT],
  ['agentSession.history', SESSION],
  ['agentSession.subscribe', SESSION],
  ['agentSession.unsubscribe', SESSION],
  ['agentSession.item', SESSION],
  ['agentSession.currentRequests', SESSION],
  ['agentSession.readVisual', SESSION],
  ['agentSession.queuedMessageEditHold', SESSION],
  ['agentSession.send', ENVELOPE_SESSION],
  ['agentSession.respondToApproval', ENVELOPE_SESSION],
  ['agentSession.respondToQuestion', ENVELOPE_SESSION],
  ['agentSession.cancel', ENVELOPE_SESSION],
  ['agentSession.queuedMessageSend', ENVELOPE_SESSION],
  ['agentSession.queuedMessageDelete', ENVELOPE_SESSION],
  ['agentSession.queuedMessageMove', ENVELOPE_SESSION],
  ['agentSession.queuedMessageUpdate', ENVELOPE_SESSION],
  ['agentSession.queuedMessagesResume', ENVELOPE_SESSION],
  // An upload names the chat it is for; the rest go by upload id, under the share socket's own caller key.
  ['agentSessionAttachment.uploadStart', SESSION],
  ['agentSessionAttachment.uploadAppend', SELF],
  ['agentSessionAttachment.uploadCommit', SELF],
  ['agentSessionAttachment.uploadAbort', SELF],
  // Both bind to the socket's own device row.
  ['pairing.getEndpoints', SELF],
  ['pairing.provisionRelay', SELF]
])
