import type { ExecutionHostId } from '../execution-host'
import type { Row } from './row-types'

/** A project header's copy for one host: that host's registration, count and workspaces. */
export function localizeProjectHeader(
  row: Extract<Row, { type: 'header' }>,
  hostId: ExecutionHostId
): Extract<Row, { type: 'header' }> {
  const { hostRepos, ...projectHeader } = row
  const repo = hostRepos?.get(hostId)
  if (!repo) {
    return row
  }
  return {
    ...projectHeader,
    repo,
    anchorRepo: row.repo,
    hostId,
    count: row.hostWorktreeCounts?.get(hostId) ?? 0,
    worktreeIds: row.hostWorktreeIds?.get(hostId) ?? []
  }
}

/** Rows that draw no host headers but all belong to `hostId`: headers still name that host's registration. */
export function localizeRowsToHost(
  rows: readonly Row[],
  hostId: ExecutionHostId | undefined
): Row[] {
  return hostId
    ? rows.map((row) =>
        row.type === 'header' && row.hostRepos ? localizeProjectHeader(row, hostId) : row
      )
    : [...rows]
}
