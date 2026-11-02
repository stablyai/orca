import type { AppState } from '@/store/types'
import type { AgentSessionLaunchRequest } from '@/lib/agent-session-launch-plan'
import { buildAgentLaunchRouteInput } from '@/lib/agent-launch-route-input'
import {
  resolveRepoExecutionHostPlatform,
  resolveWorktreeExecutionHostPlatform
} from '@/lib/execution-host-facts'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { Repo } from '../../../../shared/repo-types'
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

// Why: this selector reruns on every store write, so a target's repo resolves once per repos list.
const prospectiveRepoCache = new WeakMap<AppState['repos'], Map<string, Repo | null>>()

function prospectiveRepo(
  repos: AppState['repos'],
  repoId: string,
  hostId: string | undefined
): Repo | null {
  let byTarget = prospectiveRepoCache.get(repos)
  if (!byTarget) {
    byTarget = new Map()
    prospectiveRepoCache.set(repos, byTarget)
  }
  const key = JSON.stringify([repoId, hostId])
  if (!byTarget.has(key)) {
    byTarget.set(key, findRepoForHost(repos, repoId, { hostId }))
  }
  return byTarget.get(key) ?? null
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
    !worktreeId && repoId ? prospectiveRepo(state.repos, repoId, workspace.executionHostId) : null
  // The workspace path only refines a known OS (WSL), so readiness does not need it.
  const platform = worktreeId
    ? resolveWorktreeExecutionHostPlatform(state, worktreeId, undefined)
    : repo
      ? resolveRepoExecutionHostPlatform(state, repo, () => undefined)
      : undefined
  return platform?.kind === 'withheld' && platform.pending === true
}
