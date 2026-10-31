/** SSH and its managed server are one machine in pickers. Keep both ownership ids in the registry; expand each picker selection to both. */
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { ExecutionHostRegistryEntry } from './execution-host-registry'
import type { SshConnectionState } from './ssh-types'

/** The deployment fields host pairing reads; a WSL distro has no SSH host row to merge with. */
export type ManagedOrcadDeploymentSummary = { kind?: 'ssh'; sshTargetId: string } | { kind: 'wsl' }

export type ManagedOrcadEnvironmentSummary = {
  id: string
  orcadDeployment?: ManagedOrcadDeploymentSummary | null
}

/** The merge fields a host row carries; picker option types extend it. */
export type MergedExecutionHost = {
  id: ExecutionHostId
  /** On the row pickers show: the merged-away id it also stands for. */
  aliasHostIds?: readonly ExecutionHostId[]
  /** On the merged-away entry: the row that stands for it. */
  mergedIntoHostId?: ExecutionHostId
}

/** The SSH target this environment is the managed Orca server for; null for any other server. */
export function getManagedOrcadSshTargetId(
  environment: ManagedOrcadEnvironmentSummary
): string | null {
  const deployment = environment.orcadDeployment
  return (deployment?.kind !== 'wsl' && deployment?.sshTargetId.trim()) || null
}

/** Pair SSH hosts with managed servers in place. Show the serving route’s row: the server unless main reports SSH on its relay. */
export function annotateManagedOrcadExecutionHosts(args: {
  hosts: Map<ExecutionHostId, ExecutionHostRegistryEntry>
  runtimeEnvironments: readonly ManagedOrcadEnvironmentSummary[]
  sshConnectionStates?: ReadonlyMap<string, Pick<SshConnectionState, 'managedServer'>>
}): void {
  for (const environment of args.runtimeEnvironments) {
    const targetId = getManagedOrcadSshTargetId(environment)
    if (!targetId) {
      continue
    }
    const sshHostId = toSshExecutionHostId(targetId)
    const runtimeHostId = toRuntimeExecutionHostId(environment.id.trim())
    const sshHost = args.hosts.get(sshHostId)
    const runtimeHost = args.hosts.get(runtimeHostId)
    // An orphaned server is the machine’s only remaining row.
    if (!sshHost || !runtimeHost) {
      continue
    }
    const onRelay = args.sshConnectionStates?.get(targetId)?.managedServer?.kind === 'relay'
    const shown = onRelay ? sshHost : runtimeHost
    const mergedAway = onRelay ? runtimeHost : sshHost
    // Why the SSH host's name and detail: that is the identity the user configured.
    args.hosts.set(shown.id, {
      ...shown,
      label: sshHost.label,
      detail: sshHost.detail,
      aliasHostIds: [mergedAway.id]
    })
    args.hosts.set(mergedAway.id, {
      ...mergedAway,
      label: sshHost.label,
      mergedIntoHostId: shown.id
    })
  }
}

export function isMergedAwayExecutionHost(host: MergedExecutionHost): boolean {
  return host.mergedIntoHostId !== undefined
}

/** The rows a picker shows: one per machine. */
export function pickerExecutionHosts<T extends MergedExecutionHost>(hosts: readonly T[]): T[] {
  return hosts.filter((host) => !isMergedAwayExecutionHost(host))
}

/** Indexes hosts by id, with a merged-away id resolving to the row that stands for it. */
export function indexExecutionHostsById<T extends MergedExecutionHost>(
  hosts: readonly T[]
): Map<ExecutionHostId, T> {
  const byId = new Map<ExecutionHostId, T>(hosts.map((host) => [host.id, host]))
  for (const host of hosts) {
    const shown = host.mergedIntoHostId ? byId.get(host.mergedIntoHostId) : undefined
    if (shown) {
      byId.set(host.id, shown)
    }
  }
  return byId
}

/** Every id the given ids stand for, so a choice of a merged row matches both owners. */
export function expandEquivalentExecutionHostIds(
  hosts: readonly MergedExecutionHost[],
  hostIds: Iterable<ExecutionHostId>
): ExecutionHostId[] {
  const byId = indexExecutionHostsById(hosts)
  const expanded = new Set<ExecutionHostId>()
  for (const hostId of hostIds) {
    expanded.add(hostId)
    const shown = byId.get(hostId)
    if (shown) {
      expanded.add(shown.id)
      for (const aliasHostId of shown.aliasHostIds ?? []) {
        expanded.add(aliasHostId)
      }
    }
  }
  return [...expanded]
}

/** Widen saved selections to both ownership ids; older builds or pre-route-flip lists may hold only one. Null if unchanged. */
export function widenSavedExecutionHostIds(
  hosts: readonly MergedExecutionHost[],
  hostIds: readonly ExecutionHostId[] | null
): ExecutionHostId[] | null {
  if (!hostIds) {
    return null
  }
  const widened = expandEquivalentExecutionHostIds(hosts, hostIds)
  return widened.length === new Set(hostIds).size ? null : widened
}
