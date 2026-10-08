import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import { latestTurnAfterStructuredAgentSessionBatch } from './structured-agent-session-live-turn'

export const STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS = 48

function bypassCoalescing(event: AgentSessionSubscribeEvent): boolean {
  return (
    event.type !== 'batch' ||
    event.batch.items.some((item) => item.body.kind !== 'message' || item.body.role !== 'assistant')
  )
}

/** The list and what rides with it. */
function queuePublicationOf(event: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>) {
  return {
    queuedMessages: event.queuedMessages,
    queuePause: event.queuePause ?? null,
    nextQueuedMessageId: event.nextQueuedMessageId ?? null
  }
}

function mergeBatch(
  left: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>,
  right: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
): Extract<AgentSessionSubscribeEvent, { type: 'batch' }> {
  const items = new Map(left.batch.items.map((item) => [item.itemId, item]))
  for (const item of right.batch.items) {
    items.set(item.itemId, item)
  }
  const submissions = new Map(
    left.batch.submissions.map((submission) => [submission.clientMessageId, submission])
  )
  for (const submission of right.batch.submissions) {
    submissions.set(submission.clientMessageId, submission)
  }
  // As applying both in turn would leave it, so an older host's rows still drop a stale claim.
  const latestTurn = latestTurnAfterStructuredAgentSessionBatch(left.latestTurn, right)
  return {
    type: 'batch',
    ...(right.commands !== undefined || left.commands !== undefined
      ? { commands: right.commands !== undefined ? right.commands : left.commands }
      : {}),
    // Whole-list publication, latest wins: dropping it here would lose a draft
    // update that rode a coalesced token frame. The pause rides with its list.
    ...(right.queuedMessages !== undefined
      ? queuePublicationOf(right)
      : left.queuedMessages !== undefined
        ? queuePublicationOf(left)
        : {}),
    sessionId: right.sessionId,
    batch: {
      cursor: right.batch.cursor,
      items: [...items.values()],
      removedItemIds: [...new Set([...left.batch.removedItemIds, ...right.batch.removedItemIds])],
      submissions: [...submissions.values()]
    },
    ...(right.fence !== undefined || left.fence !== undefined
      ? { fence: right.fence ?? left.fence }
      : {}),
    ...(right.backgroundTasks !== undefined || left.backgroundTasks !== undefined
      ? {
          backgroundTasks:
            right.backgroundTasks !== undefined
              ? right.backgroundTasks
              : (left.backgroundTasks ?? null)
        }
      : {}),
    ...(right.activity !== undefined || left.activity !== undefined
      ? { activity: right.activity !== undefined ? right.activity : (left.activity ?? null) }
      : {}),
    ...(latestTurn !== undefined ? { latestTurn } : {})
  }
}

export function createStructuredAgentSessionEventCoalescer(
  emit: (event: AgentSessionSubscribeEvent) => void,
  delayMs = STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS
): { push: (event: AgentSessionSubscribeEvent) => void; flush: () => void; dispose: () => void } {
  let pending: Extract<AgentSessionSubscribeEvent, { type: 'batch' }> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) {
      const event = pending
      pending = null
      emit(event)
    }
  }
  return {
    push(event) {
      if (bypassCoalescing(event)) {
        flush()
        emit(event)
        return
      }
      if (event.type !== 'batch') {
        return
      }
      pending = pending ? mergeBatch(pending, event) : event
      timer ??= setTimeout(flush, delayMs)
    },
    flush,
    dispose() {
      if (timer) {
        clearTimeout(timer)
      }
      timer = null
      pending = null
    }
  }
}
