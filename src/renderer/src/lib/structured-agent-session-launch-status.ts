import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import {
  structuredLaunchesHoldingIdentity,
  structuredLaunchIdentity,
  subscribeStructuredAgentLaunchStatus,
  type StructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'

export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  // Any launch holding an identity for this pair, adopted conversations included, is starting here.
  // A failed one is not: it waits on its own Retry, so a new launch may go ahead.
  const identity = structuredLaunchIdentity(worktreeId, agent)
  const states = structuredLaunchesHoldingIdentity(
    (candidate) => candidate === identity || candidate.startsWith(`${identity}:resume:`)
  )
  if (states.length === 0) {
    return 'idle'
  }
  return states.some((state) => state.visibilityUnknown) ? 'unknown' : 'pending'
}

export function useStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentLaunchStatus(worktreeId, agent),
    () => 'idle'
  )
}
