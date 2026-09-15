import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type {
  StructuredAgentLaunchOptions,
  StructuredLaunchCallerGroup
} from './structured-agent-session-launch-callers'
import type { StructuredLaunchRecoveryState } from './structured-agent-session-launch-recovery'

export type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  /** Fixed by the caller that opened this launch; joiners must use the same delivery mode. */
  promptDelivery: StructuredAgentLaunchOptions['promptDelivery']
  callers: StructuredLaunchCallerGroup
}

export type StructuredAgentLaunchStatus = 'idle' | 'pending' | 'unknown'

const pendingStructuredLaunchesByIdentity = new Map<string, StructuredLaunchState>()
const structuredLaunchListeners = new Set<() => void>()

export function structuredAgentLaunchIdentity(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  resumeFrom?: StructuredAgentSessionResumeSource
): string {
  // Agent and adopted conversation identity keep unrelated launches in one workspace separate.
  return resumeFrom
    ? `${agent}:${worktreeId}:resume:${resumeFrom.providerSessionId}`
    : `${agent}:${worktreeId}`
}

export function readPendingStructuredAgentLaunch(
  identity: string
): StructuredLaunchState | undefined {
  return pendingStructuredLaunchesByIdentity.get(identity)
}

export function listPendingStructuredAgentLaunches(): StructuredLaunchState[] {
  return [...pendingStructuredLaunchesByIdentity.values()]
}

export function recordPendingStructuredAgentLaunch(state: StructuredLaunchState): void {
  pendingStructuredLaunchesByIdentity.set(state.identity, state)
}

export function deletePendingStructuredAgentLaunch(state: StructuredLaunchState): boolean {
  if (pendingStructuredLaunchesByIdentity.get(state.identity) !== state) {
    return false
  }
  return pendingStructuredLaunchesByIdentity.delete(state.identity)
}

export function notifyStructuredAgentLaunchStatusChanged(): void {
  for (const listener of structuredLaunchListeners) {
    listener()
  }
}

export function subscribeStructuredAgentLaunchStatus(listener: () => void): () => void {
  structuredLaunchListeners.add(listener)
  return () => structuredLaunchListeners.delete(listener)
}

export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  // Resume identities are distinct launch attempts but still own production for this pair.
  const identityPrefix = `${agent}:${worktreeId}:resume:`
  const states = listPendingStructuredAgentLaunches().filter(
    (state) =>
      state.identity === structuredAgentLaunchIdentity(worktreeId, agent) ||
      state.identity.startsWith(identityPrefix)
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
