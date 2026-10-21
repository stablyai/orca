import type {
  MachineProviderFailure,
  MachineProviderKey,
  MachineProviderSnapshot,
  MachineRecord
} from '../../../../shared/machine-inventory'
import type { MachineLifetime } from '../../../../shared/machine-provider-protocol'
import { machineLocalExpiresAt } from '../../../../shared/machine-inventory'
import { getMachineDisplayState, type MachineDisplayState } from './machine-display-state'

export type MachineOption = {
  providerKey: MachineProviderKey
  machineId: string
  /** The paired server whose provider owns it, or null for this app's own. */
  environmentId: string | null
  /** A paired server's machine is picked through the project's location on it; null if none. */
  locationKey: string | null
  name: string
  state: MachineDisplayState
  lifetime: MachineLifetime
  /** Local epoch ms the provider deletes it, already corrected for the provider's clock. */
  expiresAt: number | null
}

/** Why a provider can't list machines, if it can't; each has exactly one fix row. */
export type MachineGroupStatus =
  | { kind: 'ready' }
  | { kind: 'unreachable'; lastSeenAt: number | null }
  | { kind: 'sign-in' }
  | { kind: 'different-account' }
  | { kind: 'invalid-response' }

export type MachineGroupOption = {
  /** Unique across this app's providers and every paired server's. */
  key: string
  providerKey: MachineProviderKey
  name: string
  /** Set for a paired server's provider; its account actions live on that server. */
  environmentId: string | null
  /** The paired server's name, shown beside the provider's. */
  serverName: string | null
  status: MachineGroupStatus
  /** Live machines, bound to this project first, then most recent. */
  machines: readonly MachineOption[]
  archived: readonly MachineOption[]
  /** Only this app's providers create; a paired server's creates stay on that server. */
  canCreate: boolean
}

/** Local epoch ms of `expiresAt`, corrected for the provider's clock. */
function groupStatus(snapshot: MachineProviderSnapshot): MachineGroupStatus {
  const failure: MachineProviderFailure | undefined = snapshot.lastFailure
  if (!failure) {
    return { kind: 'ready' }
  }
  switch (failure.code) {
    case 'auth-required':
      return { kind: 'sign-in' }
    case 'context-mismatch':
      return { kind: 'different-account' }
    case 'invalid-response':
    case 'protocol-unsupported':
      return { kind: 'invalid-response' }
    case 'timeout':
    case 'unavailable':
    case 'not-found':
    case 'conflict':
    case 'quota':
    case 'unsupported':
    case 'cancelled':
      return { kind: 'unreachable', lastSeenAt: snapshot.listedAt ?? null }
  }
}

function toOption(
  snapshot: MachineProviderSnapshot,
  machine: MachineRecord,
  environmentId: string | null,
  locationKey: string | null
): MachineOption {
  return {
    providerKey: snapshot.providerKey,
    machineId: machine.id,
    environmentId,
    locationKey,
    name: machine.name,
    state: getMachineDisplayState(machine.state),
    lifetime: machine.lifetime,
    expiresAt: machineLocalExpiresAt(machine, snapshot.clockOffsetMs)
  }
}

/** A machine the composer runs on, wherever its provider runs. */
export type MachineChoice = {
  providerKey: MachineProviderKey
  machineId: string
  environmentId: string | null
}

/** A paired server's machine is reached through the project's location on it. */
export function isMachineOptionPickable(machine: MachineOption): boolean {
  return machine.environmentId === null || machine.locationKey !== null
}

/** One key for a machine wherever its provider runs. */
export function machineOptionKey(
  machine: Pick<MachineOption, 'environmentId' | 'providerKey' | 'machineId'>
): string {
  return `${machine.environmentId ?? ''}\0${machine.providerKey}\0${machine.machineId}`
}

/**
 * Picker groups, one per provider. Machines this project already runs on lead, then the newest;
 * Gone machines can't run anything, so they are left out.
 */
export function buildMachineGroupOptions({
  snapshots,
  isBound,
  environment = null,
  locationKeyFor = () => null
}: {
  snapshots: readonly MachineProviderSnapshot[]
  /** Whether the selected project already has a location on the machine. */
  isBound: (snapshot: MachineProviderSnapshot, machine: MachineRecord) => boolean
  /** The paired server these providers run on; null for this app's own. */
  environment?: { id: string; name: string } | null
  locationKeyFor?: (snapshot: MachineProviderSnapshot, machine: MachineRecord) => string | null
}): MachineGroupOption[] {
  const environmentId = environment?.id ?? null
  return snapshots.map((snapshot) => {
    const usable = snapshot.machines.filter((machine) => machine.state !== 'gone')
    const bound = (machine: MachineRecord): number => (isBound(snapshot, machine) ? 0 : 1)
    const ordered = [...usable].sort(
      (a, b) => bound(a) - bound(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt)
    )
    const option = (machine: MachineRecord): MachineOption =>
      toOption(snapshot, machine, environmentId, locationKeyFor(snapshot, machine))
    return {
      key: `${environmentId ?? ''}\0${snapshot.providerKey}`,
      providerKey: snapshot.providerKey,
      name: snapshot.name,
      environmentId,
      serverName: environment?.name ?? null,
      status: groupStatus(snapshot),
      machines: ordered.filter((machine) => machine.state !== 'archived').map(option),
      archived: ordered.filter((machine) => machine.state === 'archived').map(option),
      canCreate:
        environmentId === null && (snapshot.capabilities?.verbs.includes('create') ?? false)
    }
  })
}
