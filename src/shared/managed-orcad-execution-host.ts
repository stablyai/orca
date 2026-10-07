/**
 * An SSH host and the managed Orca server Orca runs on it are one machine to the user. The registry
 * keeps both ids, since workspaces, setups and folders are owned by one or the other; pickers show
 * one row for the pair and expand a choice of that row to both ids.
 */
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { ExecutionHostRegistryEntry } from './execution-host-registry'
import type { SshConnectionState } from './ssh-types'

export type ManagedOrcadEnvironmentSummary = {
  id: string
  orcadDeployment?: { sshTargetId: string } | null
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
  return environment.orcadDeployment?.sshTargetId.trim() || null
}

/**
 * Pairs each listed SSH host with its managed server, in place. The row pickers show is keyed by
 * the route serving the host now: the server, unless main reports the host on its relay.
 */
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
    // Why: an orphaned server (its SSH host removed) is the only row left for that machine.
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

/**
 * A saved host list widened to every id its merged rows stand for, or null when it already is.
 * Lists saved by an older build, or before a route flip, may hold only one of a pair.
 */
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
