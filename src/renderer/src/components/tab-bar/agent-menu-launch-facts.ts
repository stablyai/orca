import type { AppState } from '@/store/types'
import type { AgentSessionLaunchRequest } from '@/lib/agent-session-launch-plan'
import { buildAgentLaunchRouteInput } from '@/lib/agent-launch-route-input'
import { resolveWorktreeExecutionHostPlatform } from '@/lib/execution-host-facts'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  isRuntimeHostContactRevokedVerdict,
  runtimeHostContactForEntry
} from '../../../../shared/runtime-host-contact'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

export function readAgentMenuLaunchFacts(
  state: AppState,
  workspace: AgentSessionLaunchRequest['workspace'],
  worktreeId: string | undefined
) {
  const input = buildAgentLaunchRouteInput(state, { agent: 'claude', workspace })
  const host = parseExecutionHostId(input.executionHostId)
  const status =
    host?.kind === 'runtime'
      ? state.runtimeStatusByEnvironmentId.get(host.environmentId)
      : undefined
  const contact = runtimeHostContactForEntry(status)
  const terminalPlatform = worktreeId
    ? resolveWorktreeExecutionHostPlatform(
        state,
        worktreeId,
        state.getKnownWorktreeById(worktreeId)?.path
      )
    : undefined
  return {
    terminalPending:
      terminalPlatform?.kind === 'withheld' &&
      (terminalPlatform.pending ||
        (contact.verdict === 'unverifiable' &&
          ['checking', 'transport-connecting'].includes(contact.reason))),
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
