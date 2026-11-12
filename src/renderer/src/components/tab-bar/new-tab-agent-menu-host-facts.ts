import { readAgentMenuLaunchFacts } from './agent-menu-launch-facts'
import type { AppState } from '@/store/types'
import {
  buildAgentLaunchRouteInput,
  resolveAgentLaunchInventoryHost,
  type ProspectiveWorkspace
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  runtimeHostContactForEntry,
  isRuntimeHostContactRevokedVerdict
} from '../../../../shared/remote-runtime/host-status/runtime-host-contact'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

export function newTabAgentMenuHostFacts(state: AppState, workspace: ProspectiveWorkspace) {
  const input = buildAgentLaunchRouteInput(state, { agent: 'claude', workspace })
  const inventoryExecutionHostId = resolveAgentLaunchInventoryHost(state, workspace)
  const host = parseExecutionHostId(inventoryExecutionHostId)
  const status =
    host?.kind === 'runtime'
      ? state.runtimeStatusByEnvironmentId.get(host.environmentId)
      : undefined
  const contact = runtimeHostContactForEntry(status)
  return {
    executionHostId: input.executionHostId,
    inventoryExecutionHostId,
    hostPlatform: readAgentMenuLaunchFacts(state, workspace).hostPlatform,
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
