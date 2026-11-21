import { agentJournalSubmissionKey } from '../agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalTurnLifecycle
} from '../agent-session/journal/agent-session-journal-types'
import { structuredAgentTurnAnchors } from '../native-chat/transcript/turns/native-chat-turn-membership'

type GroupJournal = {
  items: readonly AgentJournalRenderItem[]
  submissions: AgentJournalSnapshot['submissions']
}

/** The host's newest turn. Callers may also carry `observedAt`; only the record id and lifecycle are read. */
type BotGroupLatestTurn = {
  itemId: string
  turn: AgentJournalTurnLifecycle
}

/** The submission a group operation (its queued or client message id) handed to the session. */
function submissionOf(snapshot: GroupJournal, operationId: string) {
  // A queued card sent again keeps its id; its latest attempt is the one that counts.
  return snapshot.submissions.findLast(
    (submission) =>
      submission.clientMessageId === operationId || submission.queuedMessageId === operationId
  )
}

/** This operation opened the host's running turn. A loaded submission counts only once the session
 *  accepted it, so a queued or rejected send is not paged as that turn. With no submission on the
 *  page, the opener is the operation id or its submission key. */
function runningTurnForOperation(
  snapshot: GroupJournal,
  operationId: string,
  latestTurn: BotGroupLatestTurn | null | undefined
): BotGroupLatestTurn | null {
  if (latestTurn?.turn.state !== 'running') {
    return null
  }
  const submission = submissionOf(snapshot, operationId)
  if (submission && submission.dispatchState !== 'accepted') {
    return null
  }
  const userItemId = latestTurn.turn.userItemId
  const opens = submission
    ? userItemId === agentJournalSubmissionKey(submission.clientMessageId) ||
      (submission.providerItemId !== null && userItemId === submission.providerItemId) ||
      submission.answeredInTurn?.turnItemId === latestTurn.itemId
    : userItemId === agentJournalSubmissionKey(operationId) || userItemId === operationId
  return opens ? latestTurn : null
}

/** Native chat's own turn attribution, read per group operation: the operation's turn rows plus
 *  the workers it started. `latestTurn` names a running turn whose opener is above this page.
 *  Omitting it keeps the loaded rows' own attribution. */
export function indexBotGroupJournal(
  snapshot: GroupJournal,
  latestTurn?: BotGroupLatestTurn | null
) {
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
    const openedTurnId =
      prompt?.turnScope?.kind === 'turn'
        ? prompt.turnScope.turnItemId
        : (keys.map((key) => openedBy.get(key)).find((turn) => turn !== undefined) ??
          submission?.answeredInTurn?.turnItemId)
    // The start row can sit above this page. The host's running turn is then the only id left.
    const turnId =
      openedTurnId ?? runningTurnForOperation(snapshot, operationId, latestTurn)?.itemId
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

/** The running turn's lifecycle when its header is not among this operation's loaded rows.
 *  A loaded header stays the source of truth. */
export function botGroupOffPageRunningTurn(
  snapshot: GroupJournal,
  operationId: string,
  latestTurn?: BotGroupLatestTurn | null
): AgentJournalTurnLifecycle | null {
  const running = runningTurnForOperation(snapshot, operationId, latestTurn)
  if (!running) {
    return null
  }
  const loaded = indexBotGroupJournal(snapshot, latestTurn)(operationId)
  return loaded.some((item) => item.body.kind === 'turn') ? null : running.turn
}

/** Page back while this operation's running turn still starts above the window. Otherwise only
 *  an admitted turn that has no loaded rows. */
export function botGroupTurnNeedsOlderPage(
  snapshot: GroupJournal,
  operationId: string,
  latestTurn?: BotGroupLatestTurn | null
): boolean {
  if (botGroupOffPageRunningTurn(snapshot, operationId, latestTurn)) {
    return true
  }
  return (
    indexBotGroupJournal(snapshot, latestTurn)(operationId).length === 0 &&
    botGroupOperationAdmitted(snapshot, operationId)
  )
}

export function createBotGroupJournalIndexer() {
  const retained = new Map<string, AgentJournalRenderItem[]>()
  return (
    snapshot: GroupJournal,
    operationIds: readonly string[],
    latestTurn?: BotGroupLatestTurn | null
  ) => {
    const allowed = new Set(operationIds)
    for (const id of retained.keys()) {
      if (!allowed.has(id)) {
        retained.delete(id)
      }
    }
    const read = indexBotGroupJournal(snapshot, latestTurn)
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
