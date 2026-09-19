import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import {
  getStructuredAgentLaunchStatus,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'

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
