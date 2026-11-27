// A group room reads its members' chat journals: which journal turn each room operation belongs to,
// and the rows of that turn. A journal turn has one owner — the first room operation that reached
// it — so a wakeup that joined a running turn shows none of that turn.
import { agentJournalSubmissionKey } from '../agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../agent-session/journal/agent-session-journal-types'
import { structuredAgentTurnAnchors } from '../native-chat/transcript/turns/native-chat-turn-membership'

export type GroupJournal = {
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

/** The journal turn a room operation reaches: the turn its send opened, or the one its own row was
 *  placed in. */
function reachedTurn(
  snapshot: GroupJournal,
  items: ReadonlyMap<string, AgentJournalRenderItem>,
  openedBy: ReadonlyMap<string, string>,
  operationId: string
): string | undefined {
  const submission = submissionOf(snapshot, operationId)
  const keys = [
    agentJournalSubmissionKey(submission?.clientMessageId ?? operationId),
    submission?.providerItemId ?? ''
  ]
  const prompt = keys.map((key) => items.get(key)).find((item) => item !== undefined)
  if (prompt?.turnScope?.kind === 'turn') {
    return prompt.turnScope.turnItemId
  }
  return (
    keys.map((key) => openedBy.get(key)).find((turn) => turn !== undefined) ??
    submission?.answeredInTurn?.turnItemId
  )
}

export type BotGroupJournalIndex = {
  /** The rows of the turn an operation reached, plus the workers it started. */
  read: (operationId: string, workerDispatchIds?: readonly string[]) => AgentJournalRenderItem[]
  /** The room operations that only joined a turn another operation opened: they show none of it. */
  joined: ReadonlySet<string>
}

/** Native chat's own turn attribution, read per group operation: the operation's turn rows plus
 *  the workers it started. */
export function indexBotGroupJournal(
  snapshot: GroupJournal,
  operationIds: readonly string[] = []
): BotGroupJournalIndex {
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
  const reached = (operationId: string) => reachedTurn(snapshot, items, openedBy, operationId)
  // A turn belongs to the first room operation that reached it, in room order: a wakeup that joined
  // a running turn reached the turn the request opened, so the room shows that turn once, under
  // the request, and the wakeup shows none of it.
  const owners = new Map<string, string>()
  for (const operationId of operationIds) {
    const turnId = reached(operationId)
    if (turnId !== undefined && !owners.has(turnId)) {
      owners.set(turnId, operationId)
    }
  }
  const listed = new Set(operationIds)
  const joined = new Set(
    operationIds.filter((operationId) => {
      const turnId = reached(operationId)
      return turnId !== undefined && owners.get(turnId) !== operationId
    })
  )
  const read = (
    operationId: string,
    workerDispatchIds: readonly string[] = []
  ): AgentJournalRenderItem[] => {
    const turnId = reached(operationId)
    if (turnId !== undefined && listed.has(operationId) && owners.get(turnId) !== operationId) {
      return []
    }
    return turnId
      ? [...(byTurn.get(turnId) ?? []), ...workerDispatchIds.flatMap((id) => workers.get(id) ?? [])]
      : []
  }
  return { read, joined }
}

/** The group operation whose message opened this turn, if one did. */
export function botGroupTurnOperation(snapshot: GroupJournal, turnItemId: string): string | null {
  const anchor = structuredAgentTurnAnchors(snapshot.items, snapshot.submissions).get(turnItemId)
  // The send that opened the turn owns it; a send steered into it only answered there.
  const submission =
    snapshot.submissions.find(
      (submission) =>
        anchor !== undefined &&
        (submission.providerItemId === anchor ||
          agentJournalSubmissionKey(submission.clientMessageId) === anchor)
    ) ??
    snapshot.submissions.find((submission) => submission.answeredInTurn?.turnItemId === turnItemId)
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
    const index = indexBotGroupJournal(snapshot, operationIds)
    const read = (operationId: string, workers: readonly string[] = []) => {
      const next = index.read(operationId, workers)
      const previous = retained.get(operationId)
      if (
        previous?.length === next.length &&
        next.every((item, position) => item === previous[position])
      ) {
        return previous
      }
      retained.set(operationId, next)
      return next
    }
    return { read, joined: index.joined }
  }
}

export function botGroupTurnItems(
  snapshot: GroupJournal,
  operationId: string,
  workerDispatchIds: readonly string[] = []
): AgentJournalRenderItem[] {
  return indexBotGroupJournal(snapshot).read(operationId, workerDispatchIds)
}
