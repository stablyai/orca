import type { AppState } from '@/store/types'
import type { AgentSessionLaunchRequest } from '@/lib/agent-session-launch-plan'
import { resolveAgentLaunchHost } from '@/lib/agent-launch-route-input'
import {
  executionHostTerminalPending,
  resolveRepoExecutionHostTarget,
  resolveWorktreeResourceTarget,
  type ExecutionHostTarget
} from '@/lib/execution-host-facts'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { getIndexedReposById } from '@/store/worktree-repo-index'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
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
  // Only the host and its capabilities are read, so skip building the full route input.
  const input = resolveAgentLaunchHost(state, workspace)
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

type TerminalTargetWorkspace = Pick<
  AgentSessionLaunchRequest['workspace'],
  'worktreeId' | 'repoId' | 'executionHostId'
>

/**
 * The terminal host a menu's launch would use, from the resource's owner alone; null when none owns
 * it. Settings are out of its reach: a focused default only places a row-less setup terminal.
 */
function resolveAgentMenuTerminalTarget(
  state: Omit<AppState, 'settings'>,
  { worktreeId, repoId, executionHostId }: TerminalTargetWorkspace
): ExecutionHostTarget | null {
  if (worktreeId) {
    return resolveWorktreeResourceTarget(state, worktreeId)
  }
  // A workspace not created yet launches on its repo's owning host: the first row with that id
  // on that host, or the id's only row. Rows on several hosts with none named settle as no owner.
  const candidates = repoId ? getIndexedReposById(state.repos, repoId) : []
  const repo = executionHostId
    ? candidates.find((row) => getRepoExecutionHostId(row) === executionHostId)
    : candidates.length === 1
      ? candidates[0]
      : undefined
  return repo ? resolveRepoExecutionHostTarget(repo) : null
}

/**
 * Terminal choices wait only while the host that will report its OS is still connecting or
 * setting up. Settled missing facts stay launchable, so the launcher gives its one refusal.
 */
export function readAgentMenuTerminalPending(
  state: AppState,
  workspace: TerminalTargetWorkspace
): boolean {
  const target = resolveAgentMenuTerminalTarget(state, workspace)
  return target ? executionHostTerminalPending(state, target) : false
}

// Every resource-owner input the target resolver reads; the build fails if WorktreeRuntimeOwnerState
// gains one this does not compare. Settings are not one (see resolveAgentMenuTerminalTarget), and
// connection and contact facts are read live.
const OWNERSHIP_INPUTS = Object.values({
  repos: (state) => state.repos,
  worktreesByRepo: (state) => selectWorktreesByRepo(state),
  detectedWorktreesByRepo: (state) => selectDetectedWorktreesByRepo(state),
  folderWorkspaces: (state) => selectFolderWorkspaces(state),
  projectGroups: (state) => state.projectGroups,
  restoredRuntimeHostIdByWorkspaceSessionKey: (state) =>
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
  activeWorktreeId: (state) => state.activeWorktreeId,
  activeWorkspaceExecutionHostId: (state) => state.activeWorkspaceExecutionHostId,
  runtimeEnvironments: (state) => state.runtimeEnvironments,
  runtimeEnvironmentCatalogHydrated: (state) => state.runtimeEnvironmentCatalogHydrated,
  removedRuntimeEnvironmentIds: (state) => state.removedRuntimeEnvironmentIds
} satisfies Record<
  Exclude<keyof WorktreeRuntimeOwnerState, 'settings'>,
  (state: AppState) => unknown
>)

/**
 * One mounted menu's readiness. The target host is resolved again only when an ownership slice
 * changes; every other store write reads just that host's connection and contact facts.
 */
export function createAgentMenuTerminalPendingSelector(
  workspace: TerminalTargetWorkspace
): (state: AppState) => boolean {
  let inputs: readonly unknown[] | null = null
  let target: ExecutionHostTarget | null = null
  return (state) => {
    const next = OWNERSHIP_INPUTS.map((read) => read(state))
    if (!inputs || next.some((value, i) => value !== inputs?.[i])) {
      inputs = next
      target = resolveAgentMenuTerminalTarget(state, workspace)
    }
    return target ? executionHostTerminalPending(state, target) : false
  }
}
