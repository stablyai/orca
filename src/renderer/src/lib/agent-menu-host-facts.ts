import type { AppState } from '@/store/types'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { resolveAgentLaunchHost, type ProspectiveWorkspace } from '@/lib/agent-launch-route-input'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import {
  isRuntimeHostContactRevokedVerdict,
  runtimeHostContactForEntry
} from '../../../shared/runtime-host-contact'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'

export function readAgentMenuHostFacts(
  state: AppState,
  workspace: ProspectiveWorkspace,
  detectionTarget: AgentDetectionTarget | undefined
) {
  const input = resolveAgentLaunchHost(state, workspace)
  const host = parseExecutionHostId(input.executionHostId)
  const status =
    host?.kind === 'runtime'
      ? state.runtimeStatusByEnvironmentId.get(host.environmentId)
      : undefined
  const contact = runtimeHostContactForEntry(status)
  return {
    failed:
      detectionTarget?.kind === 'ssh'
        ? state.remoteAgentInventoryOutcome(detectionTarget.connectionId) === 'failed'
        : detectionTarget?.kind === 'runtime'
          ? state.runtimeAgentInventoryOutcome(
              getRuntimeAgentInventoryKey(detectionTarget.environmentId, detectionTarget.worktreeId)
            ) === 'failed'
          : false,
    executionHostId: input.executionHostId,
    runtimeId: host?.kind === 'runtime' ? lastVerifiedRuntimeStatus(status)?.runtimeId : null,
    pairingRevision:
      host?.kind === 'runtime' ? getRuntimeEnvironmentRevision(host.environmentId) : undefined,
    contact: `${status?.connectionGeneration}:${status?.hostContactEpoch}:${isRuntimeHostContactRevokedVerdict(contact)}`,
    checking:
      contact.verdict === 'unverifiable' &&
      ['checking', 'transport-connecting'].includes(contact.reason),
    capabilities: input.hostCapabilities?.join(',')
  }
}
