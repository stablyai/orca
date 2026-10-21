import type {
  MachineProviderSnapshot,
  MachineRecord,
  MachineTarget
} from '../../../../shared/machine-inventory'
import { parseHostAuthorityKey } from '../../../../shared/host-authority'
import {
  getWorktreeExecutionHostId,
  isLocalExecutionHost,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

export type MachineMatch = {
  snapshot: MachineProviderSnapshot
  machine: MachineRecord
  /** The paired server whose provider owns the machine, or null for this app's own. */
  environmentId: string | null
}

/** Machine inventories by the Orca endpoint that runs their provider. */
export type MachineSources = {
  self: readonly MachineProviderSnapshot[]
  /** Inventories of paired servers, read over runtime RPC, keyed by environment id. */
  environments: Readonly<Record<string, readonly MachineProviderSnapshot[]>>
}

function findIn(
  snapshots: readonly MachineProviderSnapshot[],
  environmentId: string | null,
  matches: (machine: MachineRecord) => boolean
): MachineMatch | null {
  for (const snapshot of snapshots) {
    const machine = snapshot.machines.find(matches)
    if (machine) {
      return { snapshot, machine, environmentId }
    }
  }
  return null
}

/**
 * The machine a worktree runs on, found from the worktree's host alone: a machine is reached
 * through an SSH target or a paired server its provider recorded, so no separate binding exists.
 */
export function findMachineForHost(
  hostKey: string | null | undefined,
  sources: MachineSources
): MachineMatch | null {
  const authority = parseHostAuthorityKey(hostKey)
  if (!authority) {
    return null
  }
  const sshTargetId = authority.at === 'local' ? null : authority.at.slice('ssh:'.length)
  if (authority.endpoint.kind === 'self') {
    return sshTargetId
      ? findIn(sources.self, null, (machine) => machine.sshTargetId === sshTargetId)
      : null
  }
  const { environmentId } = authority.endpoint
  if (sshTargetId) {
    // Why: a server's SSH target id only means something inside that server's inventory.
    return findIn(
      sources.environments[environmentId] ?? [],
      environmentId,
      (machine) => machine.sshTargetId === sshTargetId
    )
  }
  // Why: an SSH machine runs worktrees on the server Orca deployed there, which names the host.
  return findIn(
    sources.self,
    null,
    (machine) =>
      machine.runtimeEnvironmentId === environmentId ||
      machine.managedEnvironmentId === environmentId
  )
}

export function machineTargetKey(target: MachineTarget): string {
  return `${target.providerKey}\0${target.machineId}`
}

/** The host key a worktree's machine is found by; plain local worktrees have none. */
export function machineHostKeyForWorktree(
  worktree: Pick<Worktree, 'hostId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | null | undefined
): ExecutionHostId | null {
  const hostId = getWorktreeExecutionHostId(worktree, repo ?? undefined)
  return isLocalExecutionHost(hostId) ? null : hostId
}

/** Every host a machine's worktrees can sit on: its SSH target, its server, its managed server. */
export function machineHostIds(machine: MachineRecord): ExecutionHostId[] {
  const ids: ExecutionHostId[] = []
  if (machine.sshTargetId) {
    ids.push(toSshExecutionHostId(machine.sshTargetId))
  }
  for (const environmentId of [machine.runtimeEnvironmentId, machine.managedEnvironmentId]) {
    if (environmentId) {
      ids.push(toRuntimeExecutionHostId(environmentId))
    }
  }
  return ids
}

/** Hosts of this app's archived machines, which the sidebar folds away. */
export function getArchivedMachineHostIds(
  snapshots: readonly MachineProviderSnapshot[]
): Set<string> {
  return new Set(
    snapshots.flatMap((snapshot) =>
      snapshot.machines
        .filter((machine) => machine.state === 'archived')
        .flatMap((machine) => machineHostIds(machine))
    )
  )
}

/** Whether a worktree on this host runs on the machine; a paired server's SSH ids are its own. */
export function hostIsOnMachine(hostKey: string | null, match: MachineMatch): boolean {
  if (!hostKey) {
    return false
  }
  if (match.environmentId === null) {
    return machineHostIds(match.machine).some((id) => id === hostKey)
  }
  const authority = parseHostAuthorityKey(hostKey)
  return (
    authority?.endpoint.kind === 'environment' &&
    authority.endpoint.environmentId === match.environmentId &&
    match.machine.sshTargetId !== undefined &&
    authority.at === `ssh:${match.machine.sshTargetId}`
  )
}

/** Every worktree on the machine: this app's own, or those a paired server runs there. */
export function worktreesOnMachine(
  match: MachineMatch,
  state: {
    worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
    repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  }
): Worktree[] {
  const repoById = new Map(state.repos.map((repo) => [repo.id, repo]))
  return Object.values(state.worktreesByRepo)
    .flat()
    .filter((worktree) =>
      hostIsOnMachine(machineHostKeyForWorktree(worktree, repoById.get(worktree.repoId)), match)
    )
}
