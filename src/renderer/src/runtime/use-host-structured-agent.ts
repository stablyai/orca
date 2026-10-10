import { useCallback, useSyncExternalStore } from 'react'
import {
  structuredAgentAcceptsImages,
  type AgentSessionRegisteredAgent
} from '../../../shared/agent-session-registered-agents'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { useAppStore } from '@/store'
import {
  readHostStructuredAgentsForRuntime,
  subscribeHostStructuredAgents
} from './host-structured-agents'
import type { RuntimeClientTarget } from './runtime-client-target'

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
