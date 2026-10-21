import type {
  MachineProviderSnapshot,
  MachineRecord,
  MachineTarget
} from '../../../../shared/machine-inventory'
import { parseHostAuthorityKey } from '../../../../shared/host-authority'

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
