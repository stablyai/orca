import type { AgentSessionSubscribeEvent } from './agent-session-wire'

export const STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS = 48

function bypassCoalescing(event: AgentSessionSubscribeEvent): boolean {
  return (
    event.type !== 'batch' ||
    event.batch.items.some((item) => item.body.kind !== 'message' || item.body.role !== 'assistant')
  )
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
  return {
    type: 'batch',
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
    ...(right.handoff || left.handoff ? { handoff: right.handoff ?? left.handoff } : {})
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
