import * as z from 'zod'
import { BOT_AGENTS, BotNameSchema } from '../bot-types'
import { BotAvatarColorSchema } from './bot-avatar-color'
import { isAdmissibleAgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../native-chat/native-chat-types'

export const BotGroupReplyMode = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bot'), botId: z.string().min(1) }),
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('mentions') })
])

/** A member's lifetime is its session: a bot that rejoins gets a new one. */
const BotGroupMemberSchema = z.object({
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  stoppedThroughSequence: z.number().int().nonnegative().optional()
})

/** Sessions of members that left a room: its history still opens there; they grant no access. */
const FormerSessionIds = z.array(z.string().min(1)).optional()

/** Another room in the group, opened from its tab's + menu: every member on a fresh session. */
const BotGroupThreadSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number(),
  members: z.array(BotGroupMemberSchema),
  formerSessionIds: FormerSessionIds,
  /** Its first post, cut to a line, which names its tab. */
  title: z.string().max(80).optional()
})

/** The room's newest post, for the sidebar row's preview; `authorName` is null for the owner. */
export const BotGroupLatestSchema = z.object({
  authorName: z.string().nullable(),
  text: z.string().max(500),
  at: z.number()
})

export const BotGroupSchema = z.object({
  id: z.string().min(1),
  name: BotNameSchema,
  hostId: z.literal('local'),
  revision: z.number().int().positive(),
  /** Its hidden home, `~/.orca/bots/<folder>`, which holds the room tab as a bot's home holds its chat. */
  folder: z.string().min(1),
  folderWorkspaceId: z.string().min(1),
  createdAt: z.number(),
  /** The original room's members; each thread holds its own sessions for the same bots. */
  members: z.array(BotGroupMemberSchema),
  formerSessionIds: FormerSessionIds,
  threads: z.array(BotGroupThreadSchema).optional(),
  replyMode: BotGroupReplyMode,
  /** Listed beside the record, never in it: its place in the sidebar, set by a drag. */
  sidebarOrder: z.number().int().nonnegative().optional(),
  /** Listed beside the record, never in it. Older hosts list neither. */
  latest: BotGroupLatestSchema.optional()
})

/** One native operation a post started; the bot's name, avatar and agent as they were then. */
const BotGroupTurnSchema = z.object({
  operationId: z.string(),
  botId: z.string(),
  botName: z.string(),
  avatar: z.string().nullable(),
  avatarColor: BotAvatarColorSchema.nullable().optional().catch(undefined),
  agent: z.enum(BOT_AGENTS),
  sessionId: z.string(),
  mailbox: z.literal(true).optional(),
  /** Read from the worker relation, never stored on the message. */
  workerDispatchIds: z.array(z.string()).optional(),
  error: z.string().optional(),
  revoked: z.literal(true).optional(),
  /** The finished reply, saved when the turn ended; null when it ended without one. Absent while
   *  the turn runs, and on turns saved before replies were. */
  reply: z.string().nullable().optional(),
  frozenItems: z
    .array(z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem))
    .optional()
})

/** An image attached to a group post, committed in the host's chat-attachment store. */
export const BotGroupMessageImageSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  bytes: z.number().int().nonnegative()
})

export const BotGroupMessageSchema = z.object({
  id: z.string().min(1),
  groupId: z.string().min(1),
  /** The thread it was posted in; absent in the original room. */
  threadId: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative(),
  author: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('owner') }),
    z.object({ kind: z.literal('bot'), id: z.string(), name: z.string() })
  ]),
  text: z.string(),
  images: z.array(BotGroupMessageImageSchema).optional(),
  createdAt: z.number(),
  rootRequestId: z.string().optional(),
  rootSequence: z.number().optional(),
  /** The member whose explicit peer request this mail turn answers; `told` when it was only status. */
  requester: z
    .object({ id: z.string(), name: z.string(), told: z.literal(true).optional() })
    .optional(),
  /** The member whose reply this follow-up turn reads, on the asker's own mail turn. */
  answeredBy: z.object({ id: z.string(), name: z.string() }).optional(),
  turns: z.array(BotGroupTurnSchema)
})

/** The human request a peer request serves, and the two member sessions it runs between. */
export const BotGroupPeerScopeSchema = z.object({
  id: z.string(),
  rootRequestId: z.string(),
  rootSequence: z.number().int().positive(),
  sourceSessionId: z.string(),
  targetSessionId: z.string()
})

/** A group saved before groups had homes: its room hung on a spare bot session. Read only to migrate. */
export const LegacyBotGroupSchema = BotGroupSchema.omit({
  folder: true,
  folderWorkspaceId: true,
  sidebarOrder: true,
  latest: true
}).extend({ anchorSessionId: z.string().min(1) })

export type BotGroupReplyMode = z.infer<typeof BotGroupReplyMode>
export type BotGroupMember = z.infer<typeof BotGroupMemberSchema>
export type BotGroupThread = z.infer<typeof BotGroupThreadSchema>
export type BotGroup = z.infer<typeof BotGroupSchema>
export type BotGroupTurn = z.infer<typeof BotGroupTurnSchema>
export type BotGroupMessageImage = z.infer<typeof BotGroupMessageImageSchema>
export type BotGroupMessage = z.infer<typeof BotGroupMessageSchema>
export type BotGroupLatest = z.infer<typeof BotGroupLatestSchema>
export type BotGroupPeerScope = z.infer<typeof BotGroupPeerScopeSchema>
export type LegacyBotGroup = z.infer<typeof LegacyBotGroupSchema>

/** An owner post's transcript blocks for desktop and mobile message rows. */
export function botGroupOwnerMessageBlocks(
  message: Pick<BotGroupMessage, 'text' | 'images'>
): NativeChatBlock[] {
  return [
    ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
    ...(message.images?.map(({ path, name }) => ({
      type: 'image-ref' as const,
      path,
      alt: name
    })) ?? [])
  ]
}
