import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostIdOrDefault,
  getWorktreeExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostKind,
  type ExecutionHostScope
} from '../execution-host'
import type { ExecutionHostHealth } from '../execution-host-registry'
import type { RuntimeCompatVerdict } from '../protocol-compat'
import type { RuntimeHostBlockedReason } from '../runtime-host-status'
import type { SshConnectionStatus } from '../ssh-types'
import type { Row } from './row-types'
import { getFolderWorkspaceHostId } from './folder-workspace-host-id'
import { countWorkspaceRows } from './host-section-workspace-count'
import { localizeProjectHeader, localizeRowsToHost } from './project-header-localization'

export type HostHeaderRow = {
  type: 'host-header'
  key: string
  hostId: ExecutionHostId
  kind: ExecutionHostKind
  label: string
  detail: string
  health: ExecutionHostHealth
  // Keep skew direction to deep-link the appropriate client/server update guidance.
  compatibility?: RuntimeCompatVerdict
  // Why: a revoked pairing needs "Re-pair", not the update guidance a version block gets.
  blockedReason?: RuntimeHostBlockedReason
  connectionStatus?: SshConnectionStatus
  collapsed: boolean
  count: number
}

export type HostSectionRow = Row | HostHeaderRow

export type HostSectionOption = {
  id: ExecutionHostId
  kind: ExecutionHostKind
  label: string
  detail: string
  health: ExecutionHostHealth
  compatibility?: RuntimeCompatVerdict
  blockedReason?: RuntimeHostBlockedReason
  connectionStatus?: SshConnectionStatus
}

function getRowHostId(row: Row, defaultHostId: ExecutionHostId): ExecutionHostId | null {
  switch (row.type) {
    case 'item':
      return getWorktreeExecutionHostId(row.worktree, row.repo, defaultHostId)
    case 'pending-creation':
    case 'imported-worktrees-card':
    case 'new-external-worktrees-inbox':
      return getRepoExecutionHostIdOrDefault(row.repo, defaultHostId)
    case 'folder-workspace':
      return getFolderWorkspaceHostId(row.folderWorkspace, row.projectGroup, defaultHostId)
    case 'header':
      return row.repo ? getRepoExecutionHostIdOrDefault(row.repo, defaultHostId) : null
  }
}

function getFallbackHost(hostId: ExecutionHostId, localHostLabel: string): HostSectionOption {
  const isLocal = hostId === LOCAL_EXECUTION_HOST_ID
  return {
    id: hostId,
    kind: isLocal ? 'local' : hostId.startsWith('ssh:') ? 'ssh' : 'runtime',
    label: isLocal ? localHostLabel : hostId,
    detail: isLocal ? 'This computer' : 'Host',
    health: isLocal ? 'local' : 'available'
  }
}

function localizePendingRowsForHost(
  rows: readonly Extract<Row, { type: 'header' }>[],
  hostId: ExecutionHostId
): Extract<Row, { type: 'header' }>[] {
  const localized: Extract<Row, { type: 'header' }>[] = []
  for (const row of rows) {
    if (!row.hostWorktreeCounts) {
      localized.push(row)
      continue
    }
    const count = row.hostWorktreeCounts.get(hostId)
    if (count !== undefined && count > 0) {
      localized.push({
        ...row,
        count,
        hostId,
        worktreeIds: row.hostWorktreeIds?.get(hostId) ?? row.worktreeIds
      })
    }
  }
  return localized
}

function getPendingRowKey(row: Extract<Row, { type: 'header' }>): string {
  return `${row.key}:${row.count}:${row.worktreeIds?.join(',') ?? ''}`
}

/** A project group's header (it names no host itself): its nesting depth, else null. */
function getProjectGroupHeaderDepth(row: Row): number | null {
  return row.type === 'header' && row.projectGroup && !row.repo
    ? (row.projectGroupDepth ?? 0)
    : null
}

export function addHostSectionRows(args: {
  rows: readonly Row[]
  hostOptions: readonly HostSectionOption[]
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  defaultHostId: ExecutionHostId
  /** The listed host's own name for itself; a phone reader must not derive it from its own platform. */
  localHostLabel: string
  // Reuse persisted host:<hostId> collapsed-group keys across restarts.
  collapsedHostKeys?: ReadonlySet<string>
  forceCollapseHosts?: boolean
  // Projects remain primary in the default view; explicit host filters retain operational host headers.
  preferProjectGrouping?: boolean
}): HostSectionRow[] {
  const visibleHostIds =
    args.visibleWorkspaceHostIds ??
    (args.workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE ? null : [args.workspaceHostScope])
  if (
    args.preferProjectGrouping &&
    args.workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE &&
    !args.visibleWorkspaceHostIds
  ) {
    return [...args.rows]
  }
  if (visibleHostIds && visibleHostIds.length <= 1) {
    return localizeRowsToHost(args.rows, visibleHostIds[0])
  }
  if (args.hostOptions.length <= 1) {
    return localizeRowsToHost(args.rows, args.hostOptions[0]?.id)
  }

  const hostOptionsById = new Map(args.hostOptions.map((host) => [host.id, host]))
  const rowsByHostId = new Map<ExecutionHostId, Row[]>()
  const globalRows: Row[] = []
  // The headers above the next host-owned row: one lane header, or a project group's path.
  let pendingRows: Extract<Row, { type: 'header' }>[] = []
  const usedPendingRows = new Set<Row>()
  // Each host's last emitted header path, so a sibling group repeats only what differs.
  const emittedPathByHostId = new Map<ExecutionHostId, string[]>()
  const flushUnusedPendingRows = (rows: readonly Extract<Row, { type: 'header' }>[]): void => {
    const unused = rows.filter((row) => !usedPendingRows.has(row))
    if (unused.length === 0) {
      return
    }
    const hostScopedRow = unused.some((row) => row.hostWorktreeCounts)
    if (!hostScopedRow) {
      globalRows.push(...unused)
      return
    }
    for (const row of unused) {
      for (const [hostId, count] of row.hostWorktreeCounts ?? []) {
        if (count <= 0) {
          continue
        }
        const hostRows = rowsByHostId.get(hostId) ?? []
        const hostIds = row.hostWorktreeIds?.get(hostId)
        hostRows.push({
          ...row,
          count,
          hostId,
          worktreeIds: hostIds ?? row.worktreeIds
        })
        rowsByHostId.set(hostId, hostRows)
      }
    }
  }

  const pushHostRow = (row: Row, rowHostId: ExecutionHostId): void => {
    const hostRows = rowsByHostId.get(rowHostId) ?? []
    const localizedPendingRows = localizePendingRowsForHost(pendingRows, rowHostId)
    const path = localizedPendingRows.map(getPendingRowKey)
    const emitted = emittedPathByHostId.get(rowHostId) ?? []
    let shared = 0
    while (shared < path.length && path[shared] === emitted[shared]) {
      shared += 1
    }
    if (shared < path.length || path.length !== emitted.length) {
      hostRows.push(...localizedPendingRows.slice(shared))
      emittedPathByHostId.set(rowHostId, path)
    }
    if (localizedPendingRows.length > 0) {
      pendingRows.forEach((pendingRow) => usedPendingRows.add(pendingRow))
    }
    hostRows.push(row)
    rowsByHostId.set(rowHostId, hostRows)
  }

  // Pending headers that do not enclose a header at `depth` end before it.
  const retainPendingAncestors = (depth: number): void => {
    const kept =
      depth > 0
        ? pendingRows.filter((pending) => (getProjectGroupHeaderDepth(pending) ?? depth) < depth)
        : []
    flushUnusedPendingRows(pendingRows.filter((pending) => !kept.includes(pending)))
    pendingRows = kept
  }

  for (const row of args.rows) {
    if (row.type === 'header' && row.repo) {
      retainPendingAncestors(row.projectGroupDepth ?? 0)
    }
    if (row.type === 'header' && row.hostRepos) {
      // A project on several hosts heads each host's own rows, including when collapsed.
      for (const hostId of row.hostRepos.keys()) {
        pushHostRow(localizeProjectHeader(row, hostId), hostId)
      }
      continue
    }
    const rowHostId = getRowHostId(row, args.defaultHostId)
    if (rowHostId) {
      pushHostRow(row, rowHostId)
      continue
    }
    // Buffer grouping headers for each host run so host headers enclose existing grouping.
    if (row.type === 'header') {
      // A nested group keeps its ancestors pending, so each host section gets the whole path.
      retainPendingAncestors(getProjectGroupHeaderDepth(row) ?? 0)
      pendingRows = [...pendingRows, row]
    } else {
      globalRows.push(row)
    }
  }

  flushUnusedPendingRows(pendingRows)

  const hostOrder: ExecutionHostId[] = []
  for (const host of args.hostOptions) {
    if (rowsByHostId.has(host.id)) {
      hostOrder.push(host.id)
    }
  }
  for (const hostId of rowsByHostId.keys()) {
    if (!hostOptionsById.has(hostId)) {
      hostOrder.push(hostId)
    }
  }

  // Show host headers only for mixed hosts; registered empty hosts remain in the scope picker.
  if (rowsByHostId.size <= 1) {
    return localizeRowsToHost(args.rows, rowsByHostId.keys().next().value)
  }

  const result: HostSectionRow[] = [...globalRows]
  const drawnHeaderKeys = new Set<string>()
  for (const hostId of hostOrder) {
    const hostRows = rowsByHostId.get(hostId)
    if (!hostRows || hostRows.length === 0) {
      continue
    }
    const host = hostOptionsById.get(hostId) ?? getFallbackHost(hostId, args.localHostLabel)
    const collapsed =
      args.forceCollapseHosts || (args.collapsedHostKeys?.has(`host:${host.id}`) ?? false)
    result.push({
      type: 'host-header',
      key: `host:${host.id}`,
      hostId: host.id,
      kind: host.kind,
      label: host.label,
      detail: host.detail,
      health: host.health,
      compatibility: host.compatibility,
      ...(host.blockedReason ? { blockedReason: host.blockedReason } : {}),
      connectionStatus: host.connectionStatus,
      collapsed,
      count: countWorkspaceRows(hostRows)
    })
    if (!collapsed) {
      result.push(
        ...hostRows.map((row): Row => {
          // A header names its section's host, so repeated copies stay distinct and act on that host.
          if (row.type === 'header') {
            const repeated = drawnHeaderKeys.has(row.key)
            drawnHeaderKeys.add(row.key)
            if (row.hostId && !repeated) {
              return row
            }
            return { ...row, hostId: row.hostId ?? hostId, ...(repeated ? { repeated: true } : {}) }
          }
          // The enclosing host header already names the owner of cards and notices.
          return 'hostContextLabel' in row && row.hostContextLabel
            ? { ...row, hostContextLabel: undefined }
            : row
        })
      )
    }
  }

  return result
}
