import type { WorkerTabStamp } from './worker-tab-stamp'

type ObservedWorkerAgent = { agentType?: string; providerSessionId?: string; replaced: boolean }
const observedAgents = new WeakMap<WorkerTabStamp, ObservedWorkerAgent>()

/** Remember the bound session in this process; missing identity only enriches the first observation. */
export function observeWorkerTabAgentIdentity(
  stamp: WorkerTabStamp,
  entry: { agentType?: string; providerSession?: { id: string } }
): boolean {
  const agentType = entry.agentType === 'unknown' ? undefined : entry.agentType
  const providerSessionId = entry.providerSession?.id
  let previous = observedAgents.get(stamp)
  if (!previous) {
    previous = { ...stamp.agentIdentity, replaced: false }
    observedAgents.set(stamp, previous)
  }
  if (
    (previous.agentType && agentType && previous.agentType !== agentType) ||
    (previous.providerSessionId &&
      providerSessionId &&
      previous.providerSessionId !== providerSessionId)
  ) {
    previous.replaced = true
  }
  previous.agentType ??= agentType
  previous.providerSessionId ??= providerSessionId
  return previous.replaced
}

export function workerTabHasNewAgent(stamp: WorkerTabStamp): boolean {
  return observedAgents.get(stamp)?.replaced === true
}
