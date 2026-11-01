import type { AppState } from '@/store/types'
import type { AgentSessionLaunchRequest } from '@/lib/agent-session-launch-plan'
import { buildAgentLaunchRouteInput } from '@/lib/agent-launch-route-input'
import {
  resolveRepoExecutionHostPlatform,
  resolveWorktreeExecutionHostPlatform
} from '@/lib/execution-host-facts'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  isRuntimeHostContactRevokedVerdict,
  runtimeHostContactForEntry
} from '../../../../shared/runtime-host-contact'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

/** Identity facts for the picker's owner and acquisition keys; readiness stays out of them. */
export function readAgentMenuLaunchFacts(
  state: AppState,
  workspace: AgentSessionLaunchRequest['workspace']
) {
  const input = buildAgentLaunchRouteInput(state, { agent: 'claude', workspace })
  const host = parseExecutionHostId(input.executionHostId)
  const status =
    host?.kind === 'runtime'
      ? state.runtimeStatusByEnvironmentId.get(host.environmentId)
      : undefined
  const contact = runtimeHostContactForEntry(status)
  return {
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

/**
 * Terminal choices wait only while the host that will report its OS is still connecting or
 * setting up. Settled missing facts stay launchable, so the launcher gives its one refusal.
 */
export function readAgentMenuTerminalPending(
  state: AppState,
  workspace: AgentSessionLaunchRequest['workspace']
): boolean {
  const { worktreeId, repoId } = workspace
  // A workspace not created yet launches on its repo's host, so read that host's facts.
  const repo =
    !worktreeId && repoId
      ? findRepoForHost(state.repos, repoId, { hostId: workspace.executionHostId })
      : null
  // The workspace path only refines a known OS (WSL), so readiness does not need it.
  const platform = worktreeId
    ? resolveWorktreeExecutionHostPlatform(state, worktreeId, undefined)
    : repo
      ? resolveRepoExecutionHostPlatform(state, repo, () => undefined)
      : undefined
  return platform?.kind === 'withheld' && platform.pending === true
}
