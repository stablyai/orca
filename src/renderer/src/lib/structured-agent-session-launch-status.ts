import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import {
  getStructuredAgentLaunchStatus,
  getStructuredAgentSessionLaunchFailureReason,
  getStructuredAgentSessionLaunchLifecycle,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'
import type { StructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'

export function useStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): ReturnType<typeof getStructuredAgentLaunchStatus> {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentLaunchStatus(worktreeId, agent),
    () => 'idle'
  )
}

export function useStructuredAgentSessionLaunchFailureReason(
  worktreeId: string,
  sessionId: string
): string | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchFailureReason(worktreeId, sessionId),
    () => null
  )
}

export function useStructuredAgentSessionLaunchLifecycle(
  worktreeId: string,
  sessionId: string
): StructuredAgentSessionLaunchLifecycle | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId),
    () => null
  )
}
