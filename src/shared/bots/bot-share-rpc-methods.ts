// What a teammate's share connection may call: one bot's chats and nothing else on the host. Every RPC
// method declares its `share` (an access below, or 'not-shared'), so none is allowed without its check
// and none is added without a decision.
import { z } from 'zod'

/** `chat`: the session it names must be one of the teammate's own chats on the shared bot.
 *  `bot`: the bot it names must be the shared bot; its handler lists only the teammate's chats.
 *  `scoped`: names nothing; what it returns comes from `botShareScopedView` alone.
 *  `attachment`: the stored file it names must be claimed by one of the teammate's own chats.
 *  `self`: bound to the caller's own connection (its Relay credential, its own uploads). */
export type BotShareMethodAccess =
  | { kind: 'chat'; sessionId: (params: unknown) => string | undefined }
  | { kind: 'bot'; botId: (params: unknown) => string | undefined }
  | { kind: 'scoped' }
  | { kind: 'self' }
  | { kind: 'attachment'; path: (params: unknown) => string | undefined }

const SessionParams = z.looseObject({ sessionId: z.string() })
const EnvelopeParams = z.looseObject({ envelope: SessionParams })
const BotParams = z.looseObject({ botId: z.string() })

export const SHARE_BY_SESSION: BotShareMethodAccess = {
  kind: 'chat',
  sessionId: (params) => SessionParams.safeParse(params).data?.sessionId
}
export const SHARE_BY_ENVELOPE_SESSION: BotShareMethodAccess = {
  kind: 'chat',
  sessionId: (params) => EnvelopeParams.safeParse(params).data?.envelope.sessionId
}
const PathParams = z.looseObject({ path: z.string() })

export const SHARE_BY_ATTACHMENT: BotShareMethodAccess = {
  kind: 'attachment',
  path: (params) => PathParams.safeParse(params).data?.path
}
export const SHARE_BY_BOT: BotShareMethodAccess = {
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
export const SHARE_SCOPED: BotShareMethodAccess = { kind: 'scoped' }
/** Bound to the share socket's own caller key or device row. */
export const SHARE_SELF: BotShareMethodAccess = { kind: 'self' }

/** A method's share decision, required on every RPC method as `permission` is. */
export type RpcMethodShare = BotShareMethodAccess | 'not-shared'
