import * as z from 'zod'
import { BotAgentReadSchema } from '../bot-types'
import { BotAvatarColorSchema } from './bot-avatar-color'
import { BotStoredOutfitSchema } from './bot-avatar-outfit'
import { isAdmissibleAgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock, NativeChatMessage } from '../native-chat/native-chat-types'
import { isQuietBotResult, quietBotResultText } from '../bot-quiet-result'
import { AutomationRunMessageSchema } from '../automations/automation-run-message'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { BotGroupRemoteMemberSchema, StoredBotFailureSchema } from './bot-group-record-schema'

export {
  BOT_GROUP_THREAD_TITLE_MAX_LENGTH,
  BotGroupLatestSchema,
  BotGroupPeerScopeSchema,
  BotGroupRemoteBotsSchema,
  BotGroupRemoteMemberSchema,
  BotGroupReplyMode,
  BotGroupSchema,
  BotGroupThreadName,
  LegacyBotGroupSchema,
  type BotGroup,
  type BotGroupLatest,
  type BotGroupMember,
  type BotGroupPeerScope,
  type BotGroupRemoteMember,
  type BotGroupThread,
  type LegacyBotGroup
} from './bot-group-record-schema'

/** One native operation a post started; the bot's name, avatar and agent as they were then. */
const BotGroupTurnSchema = lazyZodSchema(() =>
  z.object({
    operationId: z.string(),
    botId: z.string(),
    botName: z.string(),
    avatar: z.string().nullable(),
    avatarColor: BotAvatarColorSchema.nullable().optional().catch(undefined),
    avatarOutfit: BotStoredOutfitSchema.nullable().optional().catch(undefined),
    agent: BotAgentReadSchema,
    sessionId: z.string(),
    mailbox: z.literal(true).optional(),
    /** Read from the worker relation, never stored on the message. */
    workerDispatchIds: z.array(z.string()).optional(),
    error: z.string().optional(),
    /** `error`'s code, so each client can say it in its reader's language. */
    failure: StoredBotFailureSchema,
    revoked: z.literal(true).optional(),
    /** The finished reply, saved when the turn ended; null when it ended without one. Absent while
     *  the turn runs, and on turns saved before replies were. */
    reply: z.string().nullable().optional(),
    /** Its answer to another member's request: sent as mail, so its own chat shows only the call. */
    answer: z.string().optional(),
    /** The members its reply named, saved as their hand-offs were reserved: a replay wakes none. */
    handedOff: z.array(z.string()).optional(),
    /** The members it sent peer requests to: its @mentions of them wake no second turn. */
    mailed: z.array(z.string()).optional(),
    frozenItems: z
      .array(z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem))
      .optional()
  })
)

/** A post's question to one remote member, by the mail id it went with. `sending` that is not in
 *  flight never left this computer. An answer replaces a notice, never the reverse. */
export const BotGroupRemoteAskSchema = lazyZodSchema(() =>
  BotGroupRemoteMemberSchema.extend({
    requestId: z.string().min(1),
    /** `failed`: refused before that computer took it. `unknown`: it may have; an answer still lands. */
    state: z.enum(['sending', 'sent', 'failed', 'unknown']),
    error: z.string().optional(),
    /** `error`'s code, so each client can say it in its reader's language. */
    failure: StoredBotFailureSchema,
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
)

/** An image attached to a group post, committed in the host's chat-attachment store. */
export const BotGroupMessageImageSchema = lazyZodSchema(() =>
  z.object({
    path: z.string().min(1),
    name: z.string().min(1),
    bytes: z.number().int().nonnegative()
  })
)

export const BotGroupMessageSchema = lazyZodSchema(() =>
  z.object({
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
    /** Legacy, read only: the hand-off count older builds saved on a person's post. */
    handoffs: z.number().int().nonnegative().optional(),
    /** Woken by an `@Name` in the requester's reply. */
    mentioned: z.literal(true).optional(),
    /** Legacy: the paused line older builds saved after a hand-off cap; it starts no turn. */
    pausedAfter: z.number().int().positive().optional(),
    /** A member's line for a change to its items made outside the room, such as the owner's answer: a
     *  request of its own, like a person's post, that hand-offs, peer mail and Stop attach to. */
    fromItems: z.literal(true).optional(),
    /** A member's line for a worker report that landed after the request it served was stopped: a
     *  request of its own, as `fromItems` is. */
    fromReports: z.literal(true).optional(),
    /** On a post an automation's run made, served as its owner's: the run, shown as its run row. */
    automationRun: AutomationRunMessageSchema.optional().catch(undefined),
    /** Beside `automationRun`: where the run's words came from and who did its event, so a hand-off
     *  or a replay of the post keeps them out of the owner's own words. */
    memorySource: z.string().min(1).optional().catch(undefined),
    triggeredBy: z
      .object({
        source: z.string(),
        event: z.string().optional(),
        actor: z.string().optional(),
        actorId: z.string().optional(),
        place: z.string().optional()
      })
      .optional()
      .catch(undefined),
    turns: z.array(BotGroupTurnSchema),
    /** The post's questions to remote members; older or unreadable ones are dropped, never the post. */
    remoteAsks: z.array(BotGroupRemoteAskSchema).optional().catch(undefined)
  })
)

export type BotGroupRemoteAsk = z.infer<typeof BotGroupRemoteAskSchema>
export type BotGroupTurn = z.infer<typeof BotGroupTurnSchema>
export type BotGroupMessageImage = z.infer<typeof BotGroupMessageImageSchema>
export type BotGroupMessage = z.infer<typeof BotGroupMessageSchema>

/** Whether a line starts a request of its own: a person's post, an item change made outside the
 *  room, or a worker report that landed after a Stop. */
export function startsBotGroupRequest(
  message: Pick<BotGroupMessage, 'author' | 'fromItems' | 'fromReports'>
): boolean {
  return (
    message.author.kind === 'owner' || message.fromItems === true || message.fromReports === true
  )
}

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
