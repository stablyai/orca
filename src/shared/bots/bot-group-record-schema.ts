import * as z from 'zod'
import { BotAgentReadSchema, BotNameSchema } from '../bot-types'
import { BotAvatarColorSchema } from './bot-avatar-color'
import { BotStoredOutfitSchema } from './bot-avatar-outfit'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

// Read back through readBotFailure, which drops a code this build doesn't know.
export const StoredBotFailureSchema = lazyZodSchema(() =>
  z
    .object({
      code: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number()])).optional()
    })
    .optional()
    .catch(undefined)
)

export const BotGroupReplyMode = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('bot'), botId: z.string().min(1) }),
    z.object({ kind: z.literal('all') }),
    z.object({ kind: z.literal('mentions') })
  ])
)

/** A member's lifetime is its session: a bot that rejoins gets a new one. */
export const BotGroupMemberSchema = lazyZodSchema(() =>
  z.object({
    botId: z.string().min(1),
    sessionId: z.string().min(1),
    stoppedThroughSequence: z.number().int().nonnegative().optional()
  })
)

/** A bot on a paired computer in a room hosted here: it has no session here. It is asked as the
 *  owner's own question by mail, and its answer comes back by mail. Name and look as when it joined. */
export const BotGroupRemoteMemberSchema = lazyZodSchema(() =>
  z.object({
    environmentId: z.string().min(1),
    botId: z.string().min(1),
    /** Its Home Chat when it joined: questions go to that chat, so a renamed or deleted bot is never
     *  replaced by another bot of the same name. */
    chatSessionId: z.string().min(1),
    /** The paired computer's name when the bot joined. */
    computer: z.string().min(1),
    /** The room's newest post when it joined: earlier history is what it may be shown on joining. */
    joinedAfter: z.number().int().nonnegative(),
    name: BotNameSchema,
    avatar: z.string().nullable(),
    avatarColor: BotAvatarColorSchema.nullable().optional().catch(undefined),
    avatarOutfit: BotStoredOutfitSchema.nullable().optional().catch(undefined),
    agent: BotAgentReadSchema
  })
)

/** Bots on paired computers, as the desktop listed them for a create or edit. */
export const BotGroupRemoteBotsSchema = lazyZodSchema(() =>
  z.array(BotGroupRemoteMemberSchema.omit({ computer: true, joinedAfter: true })).max(31)
)

/** Sessions of members that left a room: its history still opens there; they grant no access. */
const FormerSessionIds = lazyZodSchema(() => z.array(z.string().min(1)).optional())

export const BOT_GROUP_THREAD_TITLE_MAX_LENGTH = 80

/** A thread's name given by hand: on one line and cut as its first post's name is, never empty.
 *  Bounded before the collapse so a huge title costs no more than a long one. */
export const BotGroupThreadName = lazyZodSchema(() =>
  z
    .string()
    .transform((title) =>
      title
        .slice(0, 4 * BOT_GROUP_THREAD_TITLE_MAX_LENGTH)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, BOT_GROUP_THREAD_TITLE_MAX_LENGTH)
        .trimEnd()
    )
    .pipe(z.string().min(1, 'Missing thread name'))
)

/** Another room in the group, opened from its tab's + menu: every member on a fresh session. */
export const BotGroupThreadSchema = lazyZodSchema(() =>
  z.object({
    id: z.string().min(1),
    createdAt: z.number(),
    members: z.array(BotGroupMemberSchema),
    formerSessionIds: FormerSessionIds,
    /** Its first post cut to a line, or the name its owner gave it; names its tab. */
    title: z.string().max(BOT_GROUP_THREAD_TITLE_MAX_LENGTH).optional()
  })
)

/** The room's newest post, for the sidebar row's preview; `authorName` is null for the owner. */
export const BotGroupLatestSchema = lazyZodSchema(() =>
  z.object({
    authorName: z.string().nullable(),
    text: z.string().max(500),
    at: z.number()
  })
)

export const BotGroupSchema = lazyZodSchema(() =>
  z.object({
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
    /** Bots on paired computers, asked in every room of the group. An older or unreadable list is
     *  dropped, never the group. */
    remoteMembers: z.array(BotGroupRemoteMemberSchema).optional().catch(undefined),
    formerSessionIds: FormerSessionIds,
    threads: z.array(BotGroupThreadSchema).optional(),
    replyMode: BotGroupReplyMode,
    /** Listed beside the record, never in it: its place in the sidebar, set by a drag. */
    sidebarOrder: z.number().int().nonnegative().optional(),
    /** Listed beside the record, never in it. Older hosts list neither. */
    latest: BotGroupLatestSchema.optional()
  })
)

/** The human request a peer request serves, and the two member sessions it runs between. */
export const BotGroupPeerScopeSchema = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    rootRequestId: z.string(),
    rootSequence: z.number().int().positive(),
    sourceSessionId: z.string(),
    targetSessionId: z.string()
  })
)

/** A group saved before groups had homes: its room hung on a spare bot session. Read only to migrate. */
export const LegacyBotGroupSchema = lazyZodSchema(() =>
  BotGroupSchema.omit({
    folder: true,
    folderWorkspaceId: true,
    sidebarOrder: true,
    latest: true
  }).extend({ anchorSessionId: z.string().min(1) })
)

export type BotGroupReplyMode = z.infer<typeof BotGroupReplyMode>
export type BotGroupMember = z.infer<typeof BotGroupMemberSchema>
export type BotGroupRemoteMember = z.infer<typeof BotGroupRemoteMemberSchema>
export type BotGroupThread = z.infer<typeof BotGroupThreadSchema>
export type BotGroup = z.infer<typeof BotGroupSchema>
export type BotGroupLatest = z.infer<typeof BotGroupLatestSchema>
export type BotGroupPeerScope = z.infer<typeof BotGroupPeerScopeSchema>
export type LegacyBotGroup = z.infer<typeof LegacyBotGroupSchema>
