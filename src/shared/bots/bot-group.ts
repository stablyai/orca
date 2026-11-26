import * as z from 'zod'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../agent-session/agent-session-attachments'
import { BotNameSchema } from '../bot-types'
import { agentJournalSubmissionKey } from '../agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../agent-session/journal/agent-session-journal-types'
import { structuredAgentTurnAnchors } from '../native-chat/transcript/turns/native-chat-turn-membership'
import { remoteMemberKey } from './bot-group-mentions'
import { remoteAnswerLines, remoteMemberAsked } from './bot-group-remote-context'
import {
  BotGroupRemoteBotsSchema as RemoteBots,
  BotGroupReplyMode,
  type BotGroup,
  type BotGroupMember,
  type BotGroupMessage
} from './bot-group-schema'

export {
  BotGroupReplyMode,
  botGroupOwnerMessageBlocks,
  botGroupTurnReplyText,
  withBotGroupTurnAnswer
} from './bot-group-schema'
export type {
  BotGroup,
  BotGroupLatest,
  BotGroupMember,
  BotGroupMessage,
  BotGroupMessageImage,
  BotGroupRemoteAsk,
  BotGroupRemoteMember,
  BotGroupThread,
  BotGroupTurn
} from './bot-group-schema'

/** The group and thread behind a room tab, whose entity is the group's id or a thread's. */
export function findBotGroupRoom(
  groups: readonly BotGroup[],
  roomId: string
): { group: BotGroup; threadId: string | undefined } | null {
  for (const group of groups) {
    if (group.id === roomId) {
      return { group, threadId: undefined }
    }
    if (group.threads?.some((thread) => thread.id === roomId)) {
      return { group, threadId: roomId }
    }
  }
  return null
}

/** The group as one room sees it: that room's member sessions in `members`. */
export function botGroupRoom(group: BotGroup, threadId: string | undefined): BotGroup {
  if (!threadId) {
    return group
  }
  const thread = group.threads?.find((thread) => thread.id === threadId)
  if (!thread) {
    throw new Error('This thread is no longer in the group.')
  }
  return { ...group, members: thread.members }
}

/** The room a current or former member session belongs to: the original room's (no threadId) or
 *  a thread's. For history only; access follows current members. */
export function findBotGroupRoomOfSession(
  groups: readonly BotGroup[],
  sessionId: string
): { group: BotGroup; threadId: string | undefined } | null {
  const holds = (room: Pick<BotGroup, 'members' | 'formerSessionIds'>) =>
    room.members.some((member) => member.sessionId === sessionId) ||
    room.formerSessionIds?.includes(sessionId) === true
  for (const group of groups) {
    if (holds(group)) {
      return { group, threadId: undefined }
    }
    const thread = group.threads?.find(holds)
    if (thread) {
      return { group, threadId: thread.id }
    }
  }
  return null
}

/** Every session that is or was a member of these rooms: the chats a group's items come from. */
export function botGroupSessionIds(
  rooms: readonly Pick<BotGroup, 'members' | 'formerSessionIds'>[]
): string[] {
  return rooms.flatMap((room) => [
    ...room.members.map((member) => member.sessionId),
    ...(room.formerSessionIds ?? [])
  ])
}

/** Every room's members: the original room's, then each thread's. */
export function botGroupRoomMembers(
  group: Pick<BotGroup, 'members' | 'threads'>
): BotGroupMember[][] {
  return [group.members, ...(group.threads ?? []).map((thread) => thread.members)]
}

/** A group member's own native session, as opposed to Home or any other chat. */
export function isBotGroupMemberSession(sessionId: string | null | undefined): sessionId is string {
  return sessionId?.startsWith('bot-group-member-') === true
}

/** A remote member's id in mentions and reply audiences: bot ids are unique only per computer. */
export const botGroupRemoteKey = remoteMemberKey

const GroupId = z.object({ groupId: z.string().min(1) })
/** A room in the group: one of its threads, or the original room when absent. */
const Room = GroupId.extend({ threadId: z.string().min(1).optional() })
const Revision = GroupId.extend({ revision: z.number().int().positive() })
export const BotGroupCreate = z.object({
  name: BotNameSchema,
  botIds: z.array(z.string().min(1)).min(1).max(32),
  remoteBots: RemoteBots.optional()
})
export const BotGroupRead = Room.extend({
  beforeSequence: z.number().int().positive().optional()
})
export const BotGroupUpdate = Revision.extend({
  name: BotNameSchema.optional(),
  botIds: z.array(z.string().min(1)).min(1).max(32).optional(),
  /** The whole remote roster when present; absent keeps it. */
  remoteBots: RemoteBots.optional(),
  replyMode: BotGroupReplyMode.optional()
})
export const BotGroupReorder = GroupId.extend({ sidebarOrder: z.number().int().nonnegative() })
export const BotGroupSend = Revision.extend({
  threadId: Room.shape.threadId,
  messageId: z.string().uuid(),
  text: z.string().trim().max(100_000),
  images: z
    .array(z.string().min(1).max(4096))
    .max(AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT, 'Group messages take up to 20 images.')
    .optional()
}).refine(
  (value) => value.text.length > 0 || (value.images?.length ?? 0) > 0,
  'Message text or image is required.'
)
export const BotGroupStop = Room.extend({ botId: z.string().min(1).optional() })
export const BotGroupNewThread = GroupId.extend({})
export const BotGroupDelete = GroupId

type GroupJournal = {
  items: readonly AgentJournalRenderItem[]
  submissions: AgentJournalSnapshot['submissions']
}

/** The submission a group operation (its queued or client message id) handed to the session. */
function submissionOf(snapshot: GroupJournal, operationId: string) {
  // A queued card sent again keeps its id; its latest attempt is the one that counts.
  return snapshot.submissions.findLast(
    (submission) =>
      submission.clientMessageId === operationId || submission.queuedMessageId === operationId
  )
}

/** Native chat's own turn attribution, read per group operation: the operation's turn rows plus
 *  the workers it started. */
export function indexBotGroupJournal(snapshot: GroupJournal) {
  const openedBy = new Map(
    [...structuredAgentTurnAnchors(snapshot.items, snapshot.submissions)].map(([turn, anchor]) => [
      anchor,
      turn
    ])
  )
  const items = new Map(snapshot.items.map((item) => [item.itemId, item]))
  const byTurn = new Map<string, AgentJournalRenderItem[]>()
  const workers = new Map<string, AgentJournalRenderItem>()
  for (const item of snapshot.items) {
    if (item.body.kind === 'agent-start') {
      workers.set(item.body.dispatchId, item)
    }
    const turnId =
      item.body.kind === 'turn'
        ? item.itemId
        : item.turnScope?.kind === 'turn'
          ? item.turnScope.turnItemId
          : null
    if (turnId) {
      const rows = byTurn.get(turnId) ?? []
      rows.push(item)
      byTurn.set(turnId, rows)
    }
  }
  return (
    operationId: string,
    workerDispatchIds: readonly string[] = []
  ): AgentJournalRenderItem[] => {
    const submission = submissionOf(snapshot, operationId)
    const keys = [
      agentJournalSubmissionKey(submission?.clientMessageId ?? operationId),
      submission?.providerItemId ?? ''
    ]
    const prompt = keys.map((key) => items.get(key)).find((item) => item !== undefined)
    const turnId =
      prompt?.turnScope?.kind === 'turn'
        ? prompt.turnScope.turnItemId
        : (keys.map((key) => openedBy.get(key)).find((turn) => turn !== undefined) ??
          submission?.answeredInTurn?.turnItemId)
    return turnId
      ? [...(byTurn.get(turnId) ?? []), ...workerDispatchIds.flatMap((id) => workers.get(id) ?? [])]
      : []
  }
}

/** The group operation whose message opened this turn, if one did. */
export function botGroupTurnOperation(snapshot: GroupJournal, turnItemId: string): string | null {
  const anchor = structuredAgentTurnAnchors(snapshot.items, snapshot.submissions).get(turnItemId)
  const submission = snapshot.submissions.find(
    (submission) =>
      submission.answeredInTurn?.turnItemId === turnItemId ||
      (anchor !== undefined &&
        (submission.providerItemId === anchor ||
          agentJournalSubmissionKey(submission.clientMessageId) === anchor))
  )
  return submission ? (submission.queuedMessageId ?? submission.clientMessageId) : null
}

/** The session took this operation in, so a turn with no loaded rows is older than the window,
 *  not still queued or refused. */
export function botGroupOperationAdmitted(snapshot: GroupJournal, operationId: string): boolean {
  return submissionOf(snapshot, operationId)?.dispatchState === 'accepted'
}

export function createBotGroupJournalIndexer() {
  const retained = new Map<string, AgentJournalRenderItem[]>()
  return (snapshot: GroupJournal, operationIds: readonly string[]) => {
    const allowed = new Set(operationIds)
    for (const id of retained.keys()) {
      if (!allowed.has(id)) {
        retained.delete(id)
      }
    }
    const read = indexBotGroupJournal(snapshot)
    return (operationId: string, workers: readonly string[] = []) => {
      const next = read(operationId, workers)
      const previous = retained.get(operationId)
      if (
        previous?.length === next.length &&
        next.every((item, index) => item === previous[index])
      ) {
        return previous
      }
      retained.set(operationId, next)
      return next
    }
  }
}

export function botGroupTurnItems(
  snapshot: GroupJournal,
  operationId: string,
  workerDispatchIds: readonly string[] = []
): AgentJournalRenderItem[] {
  return indexBotGroupJournal(snapshot)(operationId, workerDispatchIds)
}

export function botGroupCompletedText(items: readonly AgentJournalRenderItem[]): string | null {
  return botGroupCompletedReply(items)?.text ?? null
}

/** A turn's finished reply (`text` cut for room history, `full` whole) and when it finished; null
 *  until it completes with text. */
export function botGroupCompletedReply(
  items: readonly AgentJournalRenderItem[]
): { text: string; full: string; completedAt: number | undefined } | null {
  const turn = items.find((item) => item.body.kind === 'turn')
  if (turn?.body.kind !== 'turn' || turn.body.state !== 'completed') {
    return null
  }
  const completedAt = turn.body.completedAt
  const full = items
    .flatMap((item) =>
      item.body.kind === 'message' && item.body.role === 'assistant'
        ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    .join('\n')
  return full ? { text: full.slice(-16_000), full, completedAt } : null
}

/** What a member has not seen: posts and replies since it was last asked (all, if new), newest kept
 *  under the cap. Local replies are keyed by operation; remote answers ride on their post. */
export function botGroupContext(
  messages: readonly BotGroupMessage[],
  completed: ReadonlyMap<string, string>,
  member: Pick<BotGroupMember, 'botId' | 'sessionId'> | { remoteKey: string }
): string {
  const local = 'sessionId' in member ? member : null
  const remoteKey = 'remoteKey' in member ? member.remoteKey : null
  const seen = messages.findLastIndex((message) =>
    local
      ? message.turns.some(
          (turn) => turn.sessionId === local.sessionId && !turn.mailbox && !turn.error
        )
      : remoteMemberAsked(message, remoteKey)
  )
  const lines = messages.slice(Math.max(seen, 0)).flatMap((message, index) => [
    ...(seen !== -1 && index === 0
      ? []
      : [
          {
            author: message.author,
            text: message.text,
            ...(message.images?.length
              ? { images: message.images.map(({ name, path }) => ({ name, path })) }
              : {})
          }
        ]),
    ...message.turns.flatMap((turn) => {
      const text = completed.get(turn.operationId)
      return text && turn.botId !== local?.botId
        ? [{ author: { kind: 'bot' as const, id: turn.botId, name: turn.botName }, text }]
        : []
    }),
    ...remoteAnswerLines(message, remoteKey)
  ])
  return fitBotGroupContext(lines)
}

/** The serialized room history a member turn quotes, at most. */
export const BOT_GROUP_CONTEXT_MAX = 24_000

/** Room history lines serialized under the context budget: the oldest go first, never the last
 *  `kept` (lines a turn must see, such as the reply that handed it the turn). */
export function fitBotGroupContext(lines: readonly unknown[], kept = 0): string {
  let start = 0
  while (
    start < lines.length - kept &&
    JSON.stringify(lines.slice(start)).length > BOT_GROUP_CONTEXT_MAX
  ) {
    start += 1
  }
  return JSON.stringify(lines.slice(start))
}
