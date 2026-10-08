import { useCallback, useSyncExternalStore } from 'react'
import type { AgentSessionRegisteredAgent } from '../../../shared/agent-session-registered-agents'
import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { useAppStore } from '@/store'
import {
  readHostStructuredAgentsForRuntime,
  subscribeHostStructuredAgents
} from './host-structured-agents'
import type { RuntimeClientTarget } from './runtime-client-target'

/** Whether a chat may carry images: what its host registered for the agent, else what every build
 *  has always sent the agents it ships. An unlisted agent claims nothing. */
export function structuredAgentAcceptsImages(
  record: AgentSessionRegisteredAgent | undefined,
  agent: string
): boolean {
  return record ? record.capabilities.imagePrompts : isAgentSessionHandleProvider(agent)
}

/** The agent's record as the chat's host listed it; undefined until (or unless) it has. */
export function useHostStructuredAgent(
  target: RuntimeClientTarget,
  agent: string
): AgentSessionRegisteredAgent | undefined {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const runtimeId = useAppStore((state) =>
    environmentId === null
      ? null
      : lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(environmentId))?.runtimeId
  )
  const executionHostId =
    environmentId === null ? LOCAL_EXECUTION_HOST_ID : toRuntimeExecutionHostId(environmentId)
  const read = useCallback(
    () =>
      readHostStructuredAgentsForRuntime(executionHostId, runtimeId)?.find(
        (row) => row.agent === agent
      ),
    [agent, executionHostId, runtimeId]
  )
  return useSyncExternalStore(subscribeHostStructuredAgents, read, read)
}

export function useStructuredAgentAcceptsImages(
  target: RuntimeClientTarget,
  agent: string
): boolean {
  return structuredAgentAcceptsImages(useHostStructuredAgent(target, agent), agent)
}
