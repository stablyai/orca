import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  getLocalExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  RUNTIME_OWNED_SSH_TARGET_ID_PREFIX,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../shared/execution-host'
import { AgentApiKeysPane } from './AgentApiKeysPane'
import type { AgentApiKeyHostChoice } from './AgentApiKeyEditor'
import { useAgentApiKeys } from './use-agent-api-keys'

/** Desktop-owned: the same keys apply whichever host Settings is showing, so every known host is a choice. */
export function AgentApiKeysSection(): React.JSX.Element {
  const model = useAgentApiKeys(window.api.agentApiKeys)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const hosts = useMemo<AgentApiKeyHostChoice[]>(
    () => [
      { id: LOCAL_EXECUTION_HOST_ID, label: getLocalExecutionHostLabel() },
      // Recipe-owned SSH targets are plumbing that is replaced on every provision.
      ...[...sshTargetLabels]
        .filter(([targetId]) => !targetId.startsWith(RUNTIME_OWNED_SSH_TARGET_ID_PREFIX))
        .map(([targetId, label]) => ({ id: toSshExecutionHostId(targetId), label })),
      ...runtimeEnvironments.map((environment) => ({
        id: toRuntimeExecutionHostId(environment.id),
        label: environment.name
      }))
    ],
    [sshTargetLabels, runtimeEnvironments]
  )
  return <AgentApiKeysPane model={model} hosts={hosts} />
}
