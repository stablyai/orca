// What a teammate's share connection may call: one bot's chats and nothing else on the host. Every RPC
// method declares its `share` (an access below, or 'not-shared'), so none is allowed without its check
// and none is added without a decision.
import { z } from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

/** `chat`: the session it names must be one of the teammate's own chats on the shared bot.
 *  `bot`: the bot it names must be the shared bot; its handler lists only the teammate's chats.
 *  `scoped`: names nothing; what it returns comes from `botShareScopedView` alone.
 *  `attachment`: the stored file it names must be claimed by one of the teammate's own chats.
 *  `self`: bound to the caller's own connection (its Relay credential, its uploads, its phone).
 *  `bot-folder`: a read in the shared bot's home folder: the selector must name that folder, and the
 *  path must resolve (symlinks followed) inside it; nothing that follows symlinks out is allowed. */
export type BotShareMethodAccess =
  | { kind: 'chat'; sessionId: (params: unknown) => string | undefined }
  | { kind: 'bot'; botId: (params: unknown) => string | undefined }
  | { kind: 'scoped' }
  | { kind: 'self' }
  | { kind: 'attachment'; path: (params: unknown) => string | undefined }
  | { kind: 'bot-folder'; read: (params: unknown) => BotFolderRead | undefined }

/** What a folder read names: the workspace selector, a path in it (absent for whole-folder reads), and
 *  whether it asks to follow symlinks. */
export type BotFolderRead = z.infer<typeof BotFolderParams>
const BotFolderParams = lazyZodSchema(() =>
  z.looseObject({
    worktree: z.string(),
    relativePath: z.string().optional(),
    followSymlinks: z.boolean().optional()
  })
)

const SessionParams = lazyZodSchema(() => z.looseObject({ sessionId: z.string() }))
const EnvelopeParams = lazyZodSchema(() => z.looseObject({ envelope: SessionParams }))
const BotParams = lazyZodSchema(() => z.looseObject({ botId: z.string() }))

export const SHARE_BY_SESSION: BotShareMethodAccess = {
  kind: 'chat',
  sessionId: (params) => SessionParams.safeParse(params).data?.sessionId
}
export const SHARE_BY_ENVELOPE_SESSION: BotShareMethodAccess = {
  kind: 'chat',
  sessionId: (params) => EnvelopeParams.safeParse(params).data?.envelope.sessionId
}
const PathParams = lazyZodSchema(() => z.looseObject({ path: z.string() }))

export const SHARE_BY_ATTACHMENT: BotShareMethodAccess = {
  kind: 'attachment',
  path: (params) => PathParams.safeParse(params).data?.path
}
export const SHARE_BY_BOT: BotShareMethodAccess = {
  kind: 'bot',
  botId: (params) => BotParams.safeParse(params).data?.botId
}

export const SHARE_BY_BOT_FOLDER: BotShareMethodAccess = {
  kind: 'bot-folder',
  read: (params) => BotFolderParams.safeParse(params).data
}

/** The methods that name nothing: each needs its view in `botShareScopedView`, or the build fails. */
export const BOT_SHARE_SCOPED_METHODS = [
  'bots.list',
  'bots.roster',
  'bots.chats.own',
  'bots.agentChoices',
  'agentSession.subscribeStatus',
  'status.get',
  'bots.linear.state',
  'bots.github.state',
  'google.status'
] as const
export type BotShareScopedMethod = (typeof BOT_SHARE_SCOPED_METHODS)[number]
export const SHARE_SCOPED: BotShareMethodAccess = { kind: 'scoped' }
/** Bound to the share socket's own caller key or device row. */
export const SHARE_SELF: BotShareMethodAccess = { kind: 'self' }

/** A method's share decision, required on every RPC method as `permission` is. */
export type RpcMethodShare = BotShareMethodAccess | 'not-shared'
