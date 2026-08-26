/**
 * Which machines the Resource Manager can report on, and which one it opens to.
 *
 * Only remote Orca *runtime* hosts are selectable: they run the same collector
 * and answer `diagnostics.memory`. Plain SSH targets execute PTYs outside any
 * Orca process, so there is nothing on the far side to ask — they stay absent
 * from the switcher rather than appearing as a host that always reads zero.
 */

import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { isUserManagedRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getLocalExecutionHostLabel,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionState
} from '@/runtime/runtime-host-connection-state'
import { getAllWorktreesFromState } from '../../store/selectors'

export type ResourceManagerHost = {
  /** Execution host id — `local`, or `runtime:<encoded environment id>`. */
  id: string
  label: string
  kind: 'local' | 'runtime'
}

export type ResourceManagerHostInputs = {
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
  runtimeStatusByEnvironmentId: ReadonlyMap<string, { status?: RuntimeStatus | null } | undefined>
  hostLabelOverrides: ReadonlyMap<string, string>
  /** Kept listed even if it drops, so a live selection is never silently swapped out. */
  selectedHostId?: string
}

export function listResourceManagerHosts(inputs: ResourceManagerHostInputs): ResourceManagerHost[] {
  const hosts: ResourceManagerHost[] = [
    { id: LOCAL_EXECUTION_HOST_ID, label: getLocalExecutionHostLabel(), kind: 'local' }
  ]
  for (const environment of inputs.runtimeEnvironments) {
    if (!isUserManagedRuntimeEnvironment(environment)) {
      continue
    }
    const statusEntry = inputs.runtimeStatusByEnvironmentId.get(environment.id)
    const state = runtimeHostConnectionState({
      hasStatusEntry: Boolean(statusEntry),
      status: statusEntry?.status ?? null
    })
    const id = toRuntimeExecutionHostId(environment.id)
    // Why: a disconnected host has no snapshot to serve, so it is not worth
    // offering — unless it is the one already on screen. Dropping that one would
    // silently swap the panel to local numbers under no label at all, which reads
    // as "the remote host went quiet" instead of "we lost contact with it".
    if (!isConnectedRuntimeHostState(state) && id !== inputs.selectedHostId) {
      continue
    }
    hosts.push({
      id,
      label: inputs.hostLabelOverrides.get(id) || environment.name || environment.id,
      kind: 'runtime'
    })
  }
  return hosts
}

/**
 * The host the popover should open to: the one running the focused workspace,
 * so opening it from a remote worktree lands on that machine rather than on a
 * local view the user then has to switch away from.
 */
export function resolveDefaultResourceManagerHostId(args: {
  hosts: readonly ResourceManagerHost[]
  activeWorktreeId: string | null
  worktreeById: ReadonlyMap<string, Worktree>
  repoById: ReadonlyMap<string, Repo>
}): string {
  const worktree = args.activeWorktreeId ? args.worktreeById.get(args.activeWorktreeId) : undefined
  if (!worktree) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const hostId = getWorktreeExecutionHostId(worktree, args.repoById.get(worktree.repoId))
  const parsed = parseExecutionHostId(hostId)
  // Why: SSH-hosted workspaces have no selectable host of their own; local is the
  // only view we can honestly render for them.
  if (parsed?.kind !== 'runtime') {
    return LOCAL_EXECUTION_HOST_ID
  }
  return args.hosts.some((host) => host.id === hostId) ? hostId : LOCAL_EXECUTION_HOST_ID
}

/** State the default-host decision reads, independent of the panel's open-gated slices. */
export type ResourceManagerHostState = {
  activeWorktreeId: string | null
  repos: readonly Repo[]
  worktreesByRepo: Parameters<typeof getAllWorktreesFromState>[0]['worktreesByRepo']
}

/**
 * Why this exists: the panel's own store slices return empty collections while it
 * is closed, and the default is decided on the open edge — reading them there
 * resolved every workspace to the local host.
 */
export function resolveDefaultResourceManagerHostIdFromState(
  state: ResourceManagerHostState,
  hosts: readonly ResourceManagerHost[]
): string {
  return resolveDefaultResourceManagerHostId({
    hosts,
    activeWorktreeId: state.activeWorktreeId,
    worktreeById: new Map(
      getAllWorktreesFromState({ worktreesByRepo: state.worktreesByRepo }).map((worktree) => [
        worktree.id,
        worktree
      ])
    ),
    repoById: new Map(state.repos.map((repo) => [repo.id, repo]))
  })
}

/** Keeps a selection valid when its host disconnects while the popover is open. */
export function resolveSelectedResourceManagerHostId(
  hosts: readonly ResourceManagerHost[],
  selectedHostId: string
): string {
  return hosts.some((host) => host.id === selectedHostId) ? selectedHostId : LOCAL_EXECUTION_HOST_ID
}

export function isRemoteResourceManagerHost(hostId: string): boolean {
  return parseExecutionHostId(hostId)?.kind === 'runtime'
}
