import { shallow } from 'zustand/shallow'
import { useAppStateValueWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { readAgentMenuLaunchFacts } from '../agent/launch-menu/agent-menu-launch-facts'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  buildRouteInputForStatuses,
  resolveAgentLaunchInventoryHost,
  type ProspectiveWorkspace
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  runtimeHostContactForEntry,
  isRuntimeHostContactRevokedVerdict
} from '../../../../shared/remote-runtime/host-status/runtime-host-contact'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

export function newTabAgentMenuHostFacts(
  state: AppState,
  statuses: RuntimeStatuses,
  workspace: ProspectiveWorkspace
) {
  const input = buildRouteInputForStatuses(state, statuses, { agent: 'claude', workspace })
  const inventoryExecutionHostId = resolveAgentLaunchInventoryHost(state, workspace)
  const host = parseExecutionHostId(inventoryExecutionHostId)
  const status = host?.kind === 'runtime' ? statuses.get(host.environmentId) : undefined
  const contact = runtimeHostContactForEntry(status)
  return {
    executionHostId: input.executionHostId,
    inventoryExecutionHostId,
    hostPlatform: readAgentMenuLaunchFacts(state, statuses, workspace).hostPlatform,
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

export function useNewTabAgentMenuHostFacts(workspace: ProspectiveWorkspace) {
  return useAppStateValueWithHostStatuses(
    (state, statuses) => newTabAgentMenuHostFacts(state, statuses, workspace),
    shallow
  )
}
