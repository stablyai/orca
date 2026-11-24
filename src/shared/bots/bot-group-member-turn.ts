// What a member's turn showed in a group room: the rows it drew, and whether it said anything.
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { botGroupCompletedText } from './bot-group'
import { botGroupTurnReplyText, type BotGroupTurn } from './bot-group-schema'

/** The rows a member's turn shows: the frozen ones a retired member left, or the live session's. */
export type BotGroupTurnRows = (
  operationId: string,
  workerDispatchIds: readonly string[]
) => AgentJournalRenderItem[]

/** A member turn's rows, from wherever the room draws that turn from. */
export function botGroupTurnRows(
  turn: Pick<BotGroupTurn, 'operationId' | 'workerDispatchIds' | 'frozenItems'>,
  read: BotGroupTurnRows | undefined
): AgentJournalRenderItem[] {
  return turn.frozenItems ?? read?.(turn.operationId, turn.workerDispatchIds ?? []) ?? []
}

/** A member turn that ended saying nothing but the quiet marker: it told the room nothing, so the
 *  room shows none of it. A turn that answered a member, or whose member left, still shows. */
export function botGroupTurnSilent(
  turn: Pick<BotGroupTurn, 'answer' | 'revoked'>,
  items: readonly AgentJournalRenderItem[]
): boolean {
  if (turn.revoked) {
    return false
  }
  const text = botGroupCompletedText(items)
  return text !== null && botGroupTurnReplyText(text, turn.answer) === null
}
