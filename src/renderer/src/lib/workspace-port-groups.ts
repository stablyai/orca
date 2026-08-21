import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'
import { sortByProcessMetric, type ProcessMetricSortOption } from './sort-by-process-metric'

export type WorkspacePortGroup = {
  worktreeId: string
  repoId: string
  displayName: string
  ports: WorkspacePort[]
}

const portsByWorktreeCache = new WeakMap<WorkspacePortScanResult, Map<string, WorkspacePort[]>>()
const workspaceGroupsCache = new WeakMap<WorkspacePortScanResult, WorkspacePortGroup[]>()
const externalPortsCache = new WeakMap<WorkspacePortScanResult, WorkspacePort[]>()
const EMPTY_PORTS_BY_WORKTREE = new Map<string, WorkspacePort[]>()
const EMPTY_WORKSPACE_PORT_GROUPS: WorkspacePortGroup[] = []
const EMPTY_EXTERNAL_PORTS: WorkspacePort[] = []

function comparePorts(a: WorkspacePort, b: WorkspacePort): number {
  return a.port - b.port || (a.processName ?? '').localeCompare(b.processName ?? '')
}

export function getWorkspacePortsByWorktreeId(
  scan: WorkspacePortScanResult | null | undefined
): Map<string, WorkspacePort[]> {
  if (!scan) {
    return EMPTY_PORTS_BY_WORKTREE
  }
  const cached = portsByWorktreeCache.get(scan)
  if (cached) {
    return cached
  }
  const grouped = new Map<string, WorkspacePort[]>()
  for (const port of scan.ports) {
    if (port.kind !== 'workspace') {
      continue
    }
    const current = grouped.get(port.owner.worktreeId)
    if (current) {
      current.push(port)
    } else {
      grouped.set(port.owner.worktreeId, [port])
    }
  }
  for (const ports of grouped.values()) {
    ports.sort(comparePorts)
  }
  portsByWorktreeCache.set(scan, grouped)
  return grouped
}

export function getWorkspacePortGroups(
  scan: WorkspacePortScanResult | null | undefined
): WorkspacePortGroup[] {
  if (!scan) {
    return EMPTY_WORKSPACE_PORT_GROUPS
  }
  const cached = workspaceGroupsCache.get(scan)
  if (cached) {
    return cached
  }
  const groupsByWorktreeId = new Map<string, WorkspacePortGroup>()
  for (const port of scan.ports) {
    if (port.kind !== 'workspace') {
      continue
    }
    const current = groupsByWorktreeId.get(port.owner.worktreeId)
    if (current) {
      current.ports.push(port)
    } else {
      groupsByWorktreeId.set(port.owner.worktreeId, {
        worktreeId: port.owner.worktreeId,
        repoId: port.owner.repoId,
        displayName: port.owner.displayName,
        ports: [port]
      })
    }
  }
  const groups = [...groupsByWorktreeId.values()]
    .map((group) => ({ ...group, ports: [...group.ports].sort(comparePorts) }))
    .sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName) ||
        (a.ports[0]?.port ?? 0) - (b.ports[0]?.port ?? 0)
    )
  workspaceGroupsCache.set(scan, groups)
  return groups
}

export function getExternalWorkspacePorts(
  scan: WorkspacePortScanResult | null | undefined
): WorkspacePort[] {
  if (!scan) {
    return EMPTY_EXTERNAL_PORTS
  }
  const cached = externalPortsCache.get(scan)
  if (cached) {
    return cached
  }
  const ports = scan.ports.filter((port) => port.kind !== 'workspace').sort(comparePorts)
  externalPortsCache.set(scan, ports)
  return ports
}

function portDisplayName(port: WorkspacePort): string {
  return port.processName ?? (port.pid != null ? `PID ${port.pid}` : '')
}

/** Sum of a per-port metric across a group; `null` when no port has a sample.
 *  Dedupes by pid first — a process bound to multiple ports (e.g. IPv4 + IPv6)
 *  reports the same process-level cpu/memory on each of its WorkspacePort rows. */
function sumPortMetric(
  ports: readonly WorkspacePort[],
  pick: (port: WorkspacePort) => number | null | undefined
): number | null {
  let sum = 0
  let hasValue = false
  const seenPids = new Set<number>()
  for (const port of ports) {
    if (port.pid != null) {
      if (seenPids.has(port.pid)) {
        continue
      }
      seenPids.add(port.pid)
    }
    const value = pick(port)
    if (value != null) {
      sum += value
      hasValue = true
    }
  }
  return hasValue ? sum : null
}

/** Longest-running port's value across a group; `null` when no port has a sample. Summing ages makes no sense, so this uses max instead of sum. */
function maxPortMetric(
  ports: readonly WorkspacePort[],
  pick: (port: WorkspacePort) => number | null | undefined
): number | null {
  let max: number | null = null
  for (const port of ports) {
    const value = pick(port)
    if (value != null && (max === null || value > max)) {
      max = value
    }
  }
  return max
}

/** Sorts a copy of `ports`; same comparator the Resource Manager tree uses. */
export function sortWorkspacePortsByMetric(
  ports: readonly WorkspacePort[],
  sort: ProcessMetricSortOption
): WorkspacePort[] {
  return sortByProcessMetric(ports, sort, {
    name: portDisplayName,
    cpu: (port) => port.cpu,
    memory: (port) => port.memory,
    uptime: (port) => port.uptimeSeconds
  })
}

/** Sorts groups by their aggregate cpu/memory/uptime (or name), then sorts each group's ports the same way. Grouping by project never flattens. */
export function sortWorkspacePortGroupsByMetric(
  groups: readonly WorkspacePortGroup[],
  sort: ProcessMetricSortOption
): WorkspacePortGroup[] {
  const sortedGroups = sortByProcessMetric(groups, sort, {
    name: (group) => group.displayName,
    cpu: (group) => sumPortMetric(group.ports, (port) => port.cpu),
    memory: (group) => sumPortMetric(group.ports, (port) => port.memory),
    uptime: (group) => maxPortMetric(group.ports, (port) => port.uptimeSeconds)
  })
  return sortedGroups.map((group) => ({
    ...group,
    ports: sortWorkspacePortsByMetric(group.ports, sort)
  }))
}
