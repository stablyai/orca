import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStateValueWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { shallow } from 'zustand/shallow'
import type { AgentSessionLaunchRequest } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import {
  buildAgentLaunchRouteInput,
  buildAgentLaunchRouteView,
  resolveAgentLaunchHost,
  selectAgentLaunchRouteView,
  type AgentLaunchRouteArgs
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import {
  executionHostTerminalPending,
  resolveRepoExecutionHostTarget,
  resolveWorktreeResourceTarget,
  type ExecutionHostTarget
} from '@/runtime/hosts/platform/execution-host-facts'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import { getIndexedReposById } from '@/store/repos/repository-catalog-index'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  isRuntimeHostContactRevokedVerdict,
  runtimeHostContactForEntry
} from '../../../../../shared/remote-runtime/host-status/runtime-host-contact'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { runtimeHostPlatform } from '@/components/terminal-pane/pty-transport/host-ownership/pty-owner-machine-platform'

/** A route input read against the view's own host statuses, so a retained view stays frozen. */
export function buildAgentMenuRouteInput(
  state: AppState,
  statuses: RuntimeStatuses,
  args: AgentLaunchRouteArgs
) {
  return buildAgentLaunchRouteInput(buildAgentLaunchRouteView(state, statuses), args)
}

/** Identity facts for the picker's owner and acquisition keys; readiness stays out of them. */
export function readAgentMenuLaunchFacts(
  state: AppState,
  statuses: RuntimeStatuses,
  workspace: AgentSessionLaunchRequest['workspace']
) {
  // Only the host and its capabilities are read, so skip building the full route input.
  const input = resolveAgentLaunchHost(selectAgentLaunchRouteView(state, statuses), workspace)
  const host = parseExecutionHostId(input.executionHostId)
  const status = host?.kind === 'runtime' ? statuses.get(host.environmentId) : undefined
  const contact = runtimeHostContactForEntry(status)
  return {
    executionHostId: input.executionHostId,
    runtimeId: host?.kind === 'runtime' ? lastVerifiedRuntimeStatus(status)?.runtimeId : null,
    hostPlatform:
      host?.kind === 'local'
        ? getRendererAppPlatform()
        : host?.kind === 'runtime'
          ? runtimeHostPlatform(statuses, host.environmentId)
          : null,
    pairingRevision:
      host?.kind === 'runtime' ? getRuntimeEnvironmentRevision(host.environmentId) : undefined,
    contact: `${status?.connectionGeneration}:${status?.hostContactEpoch}:${isRuntimeHostContactRevokedVerdict(contact)}`,
    checking:
      contact.verdict === 'unverifiable' &&
      ['checking', 'transport-connecting'].includes(contact.reason),
    capabilities: input.hostCapabilities?.join(',')
  }
}

/** The view's launch facts, reading host statuses through their owner. */
export function useAgentMenuLaunchFacts(workspace: AgentSessionLaunchRequest['workspace']) {
  return useAppStateValueWithHostStatuses(
    (state, statuses) => readAgentMenuLaunchFacts(state, statuses, workspace),
    shallow
  )
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
  statuses: RuntimeStatuses,
  workspace: TerminalTargetWorkspace
): boolean {
  const target = resolveAgentMenuTerminalTarget(state, workspace)
  return target ? executionHostTerminalPending(state, statuses, target) : false
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
): (state: AppState, statuses: RuntimeStatuses) => boolean {
  let inputs: readonly unknown[] | null = null
  let target: ExecutionHostTarget | null = null
  return (state, statuses) => {
    const next = OWNERSHIP_INPUTS.map((read) => read(state))
    if (!inputs || next.some((value, i) => value !== inputs?.[i])) {
      inputs = next
      target = resolveAgentMenuTerminalTarget(state, workspace)
    }
    return target ? executionHostTerminalPending(state, statuses, target) : false
  }
}
