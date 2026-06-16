import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  getRepoExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostKind,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../../shared/execution-host-registry'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import { PINNED_GROUP_KEY } from './worktree-list-groups'
import type { Row } from './worktree-list-groups'

export type HostHeaderRow = {
  type: 'host-header'
  key: string
  hostId: ExecutionHostId
  kind: ExecutionHostKind
  label: string
  detail: string
  health: ExecutionHostHealth
  // Why: blocked-host guidance in the header menu needs the verdict reason so
  // it can deep-link an "Update server/client required" row per skew direction.
  compatibility?: RuntimeCompatVerdict
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
  connectionStatus?: SshConnectionStatus
}

function getRepoHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  // Why: explicit executionHostId must win over the focused/default host, or
  // runtime-owned repos group under whichever host happens to be focused.
  if (repo?.connectionId || repo?.executionHostId) {
    return getRepoExecutionHostId(repo)
  }
  return defaultHostId
}

function getSshHostId(connectionId: string): ExecutionHostId {
  return `ssh:${encodeURIComponent(connectionId)}` as ExecutionHostId
}

function getFolderWorkspaceHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId'>,
  projectGroup: Pick<ProjectGroup, 'connectionId'>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  const connectionId = folderWorkspace.connectionId ?? projectGroup.connectionId
  return connectionId ? getSshHostId(connectionId) : defaultHostId
}

function getRowHostId(row: Row, defaultHostId: ExecutionHostId): ExecutionHostId | null {
  switch (row.type) {
    case 'item':
      return getRepoHostId(row.repo, defaultHostId)
    case 'pending-creation':
    case 'imported-worktrees-card':
      return getRepoHostId(row.repo, defaultHostId)
    case 'folder-workspace':
      return getFolderWorkspaceHostId(row.folderWorkspace, row.projectGroup, defaultHostId)
    case 'header':
      return row.repo ? getRepoHostId(row.repo, defaultHostId) : null
  }
}

function getFallbackHost(hostId: ExecutionHostId): HostSectionOption {
  const isLocal = hostId === LOCAL_EXECUTION_HOST_ID
  return {
    id: hostId,
    kind: isLocal ? 'local' : hostId.startsWith('ssh:') ? 'ssh' : 'runtime',
    label: isLocal ? getLocalExecutionHostLabel() : hostId,
    detail: isLocal ? 'This computer' : 'Host',
    health: isLocal ? 'local' : 'available'
  }
}

function countWorktreeRows(rows: readonly Row[]): number {
  // Why: a collapsed repo group contributes a header row but no item rows;
  // fall back to the header's own count so the host badge doesn't read 0
  // while a visibly populated project sits right under it.
  let count = 0
  const seenWorktreeIds = new Set<string>()
  let pendingHeaderCount: number | null = null
  let pendingHeaderHadItems = false
  const flushHeader = (): void => {
    if (pendingHeaderCount !== null && !pendingHeaderHadItems) {
      count += pendingHeaderCount
    }
    pendingHeaderCount = null
    pendingHeaderHadItems = false
  }
  for (const row of rows) {
    if (row.type === 'header') {
      flushHeader()
      pendingHeaderCount = row.key === PINNED_GROUP_KEY ? null : row.count
      continue
    }
    if (row.type === 'item') {
      if (!seenWorktreeIds.has(row.worktree.id)) {
        count += 1
        seenWorktreeIds.add(row.worktree.id)
      }
      pendingHeaderHadItems = pendingHeaderCount !== null
    }
  }
  flushHeader()
  return count
}

export function addHostSectionRows(args: {
  rows: readonly Row[]
  hostOptions: readonly HostSectionOption[]
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  defaultHostId: ExecutionHostId
  // Why: host sections reuse the sidebar's persisted collapsed-group keys
  // (`host:<hostId>`) so collapse state survives restarts like other groups.
  collapsedHostKeys?: ReadonlySet<string>
  forceCollapseHosts?: boolean
  // Why: in the default Projects view, project is the user's primary object
  // and host is context inside it. Explicit host filters still keep host
  // headers as an operational/troubleshooting view.
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
  if ((visibleHostIds && visibleHostIds.length <= 1) || args.hostOptions.length <= 1) {
    return [...args.rows]
  }

  const hostOptionsById = new Map(args.hostOptions.map((host) => [host.id, host]))
  const rowsByHostId = new Map<ExecutionHostId, Row[]>()
  const globalRows: Row[] = []
  let pendingRows: Extract<Row, { type: 'header' }>[] = []
  let pendingRowsWereUsed = false
  const pendingRowsKeyByHostId = new Map<ExecutionHostId, string>()

  for (const row of args.rows) {
    const rowHostId = getRowHostId(row, args.defaultHostId)
    if (rowHostId) {
      const hostRows = rowsByHostId.get(rowHostId) ?? []
      if (pendingRows.length > 0) {
        const pendingRowsKey = pendingRows.map((pendingRow) => pendingRow.key).join('\0')
        if (pendingRowsKeyByHostId.get(rowHostId) !== pendingRowsKey) {
          hostRows.push(...pendingRows)
          pendingRowsKeyByHostId.set(rowHostId, pendingRowsKey)
        }
        pendingRowsWereUsed = true
      }
      hostRows.push(row)
      rowsByHostId.set(rowHostId, hostRows)
      continue
    }
    // Why: status/"All" headers describe the rows that follow. Buffer them
    // for every host-owned run so host remains above the existing grouping.
    if (row.type === 'header') {
      pendingRows = [row]
      pendingRowsWereUsed = false
    } else {
      globalRows.push(row)
    }
  }

  if (pendingRows.length > 0 && !pendingRowsWereUsed) {
    globalRows.push(...pendingRows)
  }

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

  // Why: a lone host section is pure noise — the grouping only earns its keep
  // when there are at least two host sections to tell apart. Registered-but-
  // empty hosts stay visible in the scope picker, not as headers.
  if (rowsByHostId.size <= 1) {
    return [...args.rows]
  }

  const result: HostSectionRow[] = [...globalRows]
  for (const hostId of hostOrder) {
    const hostRows = rowsByHostId.get(hostId)
    if (!hostRows || hostRows.length === 0) {
      continue
    }
    const host = hostOptionsById.get(hostId) ?? getFallbackHost(hostId)
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
      connectionStatus: host.connectionStatus,
      collapsed,
      count: countWorktreeRows(hostRows)
    })
    if (!collapsed) {
      result.push(...hostRows)
    }
  }

  return result
}
