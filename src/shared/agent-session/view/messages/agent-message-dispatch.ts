import type { AgentMessageSource } from '../../journal/agent-session-message-source'
import type { OrchestrationSessionWorker } from '../../../orchestration-session-workers'

/** A reused worker terminal or chat runs several Dispatches; its mail belongs to the newest one that
 *  had started when the mail was sent. A busy chat takes mail at its next turn edge, so a report can
 *  arrive after its Dispatch settled and still belong to it. */
function newestStartedBy(
  workers: readonly OrchestrationSessionWorker[],
  at: number
): OrchestrationSessionWorker | undefined {
  let newest: OrchestrationSessionWorker | undefined
  for (const worker of workers) {
    if (worker.startedAt <= at && (!newest || worker.startedAt > newest.startedAt)) {
      newest = worker
    }
  }
  return newest
}

/**
 * The chat's own worker a message is about: the Dispatch a start names, else the one Dispatch every
 * sender of the mail had most recently started when it was sent. Matched by id or mailbox address, never by name;
 * undefined when the message is from anyone else, the match is ambiguous, or the host is too old to say.
 */
export function agentMessageSessionWorker(
  message: { agentStartDispatchId?: string; from?: AgentMessageSource; timestamp?: number | null },
  workers: readonly OrchestrationSessionWorker[]
): OrchestrationSessionWorker | undefined {
  if (message.agentStartDispatchId) {
    return workers.find((worker) => worker.dispatchId === message.agentStartDispatchId)
  }
  const senders = message.from?.senders ?? []
  const sentAt = message.timestamp
  let found: OrchestrationSessionWorker | undefined
  for (const { party } of senders) {
    const exact = workers.find((candidate) => party.address === `dispatch:${candidate.dispatchId}`)
    const sameSender = workers.filter(
      (candidate) =>
        (candidate.address != null && party.address === candidate.address) ||
        (party.orcaSessionId !== null && party.orcaSessionId === candidate.chatSessionId)
    )
    // Without a send time only a sender with one Dispatch is certain.
    const running =
      sentAt === null || sentAt === undefined
        ? sameSender.length === 1
          ? sameSender[0]
          : undefined
        : newestStartedBy(sameSender, sentAt)
    const worker = exact ?? running
    if (!worker || (found && found !== worker)) {
      return undefined
    }
    found = worker
  }
  return found
}
