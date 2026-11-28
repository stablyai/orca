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

type WorkerIndex = {
  byDispatch: ReadonlyMap<string, OrchestrationSessionWorker>
  byAddress: ReadonlyMap<string, number[]>
  bySession: ReadonlyMap<string, number[]>
}

const DISPATCH_ADDRESS = 'dispatch:'
// One index per published roster, so every row of a chat looks its sender up instead of scanning.
const workerIndexes = new WeakMap<readonly OrchestrationSessionWorker[], WorkerIndex>()

function indexOf(workers: readonly OrchestrationSessionWorker[]): WorkerIndex {
  const cached = workerIndexes.get(workers)
  if (cached) {
    return cached
  }
  const byDispatch = new Map<string, OrchestrationSessionWorker>()
  const byAddress = new Map<string, number[]>()
  const bySession = new Map<string, number[]>()
  const add = (map: Map<string, number[]>, key: string, at: number): void => {
    const list = map.get(key)
    if (list) {
      list.push(at)
    } else {
      map.set(key, [at])
    }
  }
  workers.forEach((worker, at) => {
    if (!byDispatch.has(worker.dispatchId)) {
      byDispatch.set(worker.dispatchId, worker)
    }
    if (worker.address != null) {
      add(byAddress, worker.address, at)
    }
    if (worker.chatSessionId !== null) {
      add(bySession, worker.chatSessionId, at)
    }
  })
  const index = { byDispatch, byAddress, bySession }
  workerIndexes.set(workers, index)
  return index
}

/** The roster's workers matching a sender by mailbox address or chat session, in roster order. */
function sameSenderWorkers(
  workers: readonly OrchestrationSessionWorker[],
  index: WorkerIndex,
  party: { address: string; orcaSessionId: string | null }
): OrchestrationSessionWorker[] {
  const byAddress = index.byAddress.get(party.address) ?? []
  const bySession =
    party.orcaSessionId === null ? [] : (index.bySession.get(party.orcaSessionId) ?? [])
  const at =
    bySession.length === 0
      ? byAddress
      : [...new Set([...byAddress, ...bySession])].sort((a, b) => a - b)
  return at.map((each) => workers[each]!)
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
  if (workers.length === 0) {
    return undefined
  }
  const index = indexOf(workers)
  if (message.agentStartDispatchId) {
    return index.byDispatch.get(message.agentStartDispatchId)
  }
  const senders = message.from?.senders ?? []
  const sentAt = message.timestamp
  let found: OrchestrationSessionWorker | undefined
  for (const { party } of senders) {
    const exact = party.address.startsWith(DISPATCH_ADDRESS)
      ? index.byDispatch.get(party.address.slice(DISPATCH_ADDRESS.length))
      : undefined
    const sameSender = sameSenderWorkers(workers, index, party)
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
