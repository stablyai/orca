import * as z from 'zod'
import { BOT_AGENTS, BotNameSchema } from '../bot-types'
import { BotAvatarColorSchema } from './bot-avatar-color'
import { BotStoredOutfitSchema } from './bot-avatar-outfit'
import { isAdmissibleAgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock, NativeChatMessage } from '../native-chat/native-chat-types'
import { isQuietBotResult, quietBotResultText } from '../bot-quiet-result'

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

/** A bot on a paired computer in a room hosted here: it has no session here. It is asked as the
 *  owner's own question by mail, and its answer comes back by mail. Name and look as when it joined. */
export const BotGroupRemoteMemberSchema = z.object({
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
  agent: z.enum(BOT_AGENTS)
})

/** Bots on paired computers, as the desktop listed them for a create or edit. */
export const BotGroupRemoteBotsSchema = z
  .array(BotGroupRemoteMemberSchema.omit({ computer: true, joinedAfter: true }))
  .max(31)

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

/** One native operation a post started; the bot's name, avatar and agent as they were then. */
const BotGroupTurnSchema = z.object({
  operationId: z.string(),
  botId: z.string(),
  botName: z.string(),
  avatar: z.string().nullable(),
  avatarColor: BotAvatarColorSchema.nullable().optional().catch(undefined),
  avatarOutfit: BotStoredOutfitSchema.nullable().optional().catch(undefined),
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
  /** Its answer to another member's request: sent as mail, so its own chat shows only the call. */
  answer: z.string().optional(),
  /** The members its reply named, saved as their hand-offs were reserved: a replay wakes none. */
  handedOff: z.array(z.string()).optional(),
  frozenItems: z
    .array(z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem))
    .optional()
})

/** A post's question to one remote member, by the mail id it went with. `sending` that is not in
 *  flight never left this computer. An answer replaces a notice, never the reverse. */
export const BotGroupRemoteAskSchema = BotGroupRemoteMemberSchema.extend({
  requestId: z.string().min(1),
  /** `failed`: refused before that computer took it. `unknown`: it may have; an answer still lands. */
  state: z.enum(['sending', 'sent', 'failed', 'unknown']),
  error: z.string().optional(),
  /** The room was stopped while this ask was unanswered; that computer may still answer. */
  stopped: z.literal(true).optional(),
  reply: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('answer'),
        text: z.string(),
        /** Shortened here; the whole answer is in this computer's mail. */
        truncated: z.literal(true).optional()
      }),
      /** That computer told this one the bot won't answer. */
      z.object({ kind: z.literal('notice') })
    ])
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
  /** On a person's post: the turns its members' `@Name` replies have woken so far. */
  handoffs: z.number().int().nonnegative().optional(),
  /** Woken by an `@Name` in the requester's reply; counts toward its post's hand-off limit. */
  mentioned: z.literal(true).optional(),
  /** The quiet line held where the post's hand-offs reached this limit; it starts no turn. */
  pausedAfter: z.number().int().positive().optional(),
  turns: z.array(BotGroupTurnSchema),
  /** The post's questions to remote members; older or unreadable ones are dropped, never the post. */
  remoteAsks: z.array(BotGroupRemoteAskSchema).optional().catch(undefined)
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
export type BotGroupRemoteMember = z.infer<typeof BotGroupRemoteMemberSchema>
export type BotGroupRemoteAsk = z.infer<typeof BotGroupRemoteAskSchema>
export type BotGroupThread = z.infer<typeof BotGroupThreadSchema>
export type BotGroup = z.infer<typeof BotGroupSchema>
export type BotGroupTurn = z.infer<typeof BotGroupTurnSchema>
export type BotGroupMessageImage = z.infer<typeof BotGroupMessageImageSchema>
export type BotGroupMessage = z.infer<typeof BotGroupMessageSchema>
export type BotGroupLatest = z.infer<typeof BotGroupLatestSchema>
export type BotGroupPeerScope = z.infer<typeof BotGroupPeerScopeSchema>
export type LegacyBotGroup = z.infer<typeof LegacyBotGroupSchema>

const WORD_CHARACTER = /[\p{L}\p{N}]/u

/** Whether a turn's own words already say its answer to a member's request, as whole words: an
 *  answer of `42` is not said by `142 files`. */
function holdsAnswer(words: string, answer: string): boolean {
  const said = answer.trim()
  for (let at = words.indexOf(said); at !== -1; at = words.indexOf(said, at + 1)) {
    const before = words[at - 1] ?? ''
    const after = words[at + said.length] ?? ''
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) {
      return true
    }
  }
  return false
}

/** A turn's reply as room history: its answer to a member's request added unless the reply
 *  already says it, and a quiet reply's marker dropped. Null when neither has words. */
export function botGroupTurnReplyText(
  reply: string | null | undefined,
  answer: string | undefined
): string | null {
  const said = reply && isQuietBotResult(reply) ? quietBotResultText(reply) : (reply ?? '')
  if (!answer?.trim() || holdsAnswer(said, answer)) {
    return said || null
  }
  return said ? `${said}\n\n${answer}` : answer
}

/** A turn's rows as the room draws them on desktop and mobile: its answer to a member's request
 *  closes them, unless its own words already said it. */
export function withBotGroupTurnAnswer(
  messages: NativeChatMessage[],
  turn: Pick<BotGroupTurn, 'operationId' | 'answer'>
): NativeChatMessage[] {
  const words = messages
    .flatMap((message) =>
      message.role === 'assistant'
        ? message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    .join('\n')
  return turn.answer?.trim() && !holdsAnswer(words, turn.answer)
    ? [
        ...messages,
        {
          id: `${turn.operationId}:answer`,
          role: 'assistant',
          blocks: [{ type: 'text', text: turn.answer }],
          timestamp: null,
          source: 'transcript'
        }
      ]
    : messages
}

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
