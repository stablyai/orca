import { parseExecutionHostId } from '../execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../worktree/host-qualified-identity'
import {
  getSameStoreLineageParent,
  resolveLineageParentsByPolicy
} from '../worktree/lineage/workspace-lineage-graph'
import {
  buildCrossStoreLineageViewOfRows,
  OWN_LINEAGE_STORE_KEY
} from '../worktree/lineage/cross-store-lineage-resolution'
import type { WorkspaceLineageEdge, WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import type { SidebarFeedDomains } from './sidebar-feed-domains'
import type { SidebarFeedWorkspace } from './sidebar-feed-worktrees'
import type { SidebarLineageParentIdentities } from './worktree-lineage-projection'

const NO_LINEAGE_MAP: Readonly<Record<string, WorktreeLineage>> = {}

/** How a reader treats an older server's edge that carries no instance ids. */
export type FeedLineagePolicy = {
  /** The phone has always nested by such edges, and kept their loops; desktop never has. */
  acceptLegacyLineage?: boolean
}

/** Parents over every feed row: cross-store records, folder workspace parents and, for the phone,
 * older servers' edges without instance ids. Undefined while no row carries any of them, so the
 * builder nests exactly as before. Store identities are the host's own (desktop facts) and each paired
 * server's as the host verified it. */
export function resolveFeedLineageParentIdentities(
  domains: Pick<SidebarFeedDomains, 'desktop' | 'pairedServerHosts'>,
  workspaces: readonly SidebarFeedWorkspace[],
  policy: FeedLineagePolicy = {}
): SidebarLineageParentIdentities | undefined {
  const crossStoreByRow = new Map<Worktree, unknown>()
  const folderEdgeByRow = new Map<Worktree, WorkspaceLineageEdge>()
  const legacyParentIdByRow = new Map<Worktree, string>()
  for (const entry of workspaces) {
    if (entry.crossStoreParent && !entry.folderWorkspace) {
      crossStoreByRow.set(entry.worktree, entry.crossStoreParent)
    }
    if (entry.workspaceLineage && !entry.folderWorkspace) {
      folderEdgeByRow.set(entry.worktree, entry.workspaceLineage)
    }
    if (policy.acceptLegacyLineage && entry.legacyLineage) {
      legacyParentIdByRow.set(entry.worktree, entry.legacyLineage.parentWorktreeId)
    }
  }
  if (crossStoreByRow.size === 0 && folderEdgeByRow.size === 0 && legacyParentIdByRow.size === 0) {
    return undefined
  }
  const rows = new Map(
    workspaces.map((entry) => [getWorktreeHostIdentity(entry.worktree), entry.worktree])
  )
  // An older server's edge without instance ids sits where a checked worktree edge would.
  const legacyParentOf = (row: Worktree): Worktree | undefined => {
    const parentId = legacyParentIdByRow.get(row)
    const parent =
      parentId === undefined
        ? undefined
        : rows.get(composeWorktreeHostIdentity(row.hostId, parentId))
    return parent === row ? undefined : parent
  }
  const parents = resolveLineageParentsByPolicy(rows, {
    sameStoreParentOf: (row) =>
      getSameStoreLineageParent(row, NO_LINEAGE_MAP, rows) ?? legacyParentOf(row),
    crossStoreLineage:
      crossStoreByRow.size > 0 ? crossStoreViewOf(domains, rows, crossStoreByRow) : undefined,
    folderRecordOf: folderEdgeByRow.size > 0 ? (row) => folderEdgeByRow.get(row) : undefined,
    keepSameStoreCycles: policy.acceptLegacyLineage
  })
  return new Map(
    [...parents].map(([identity, parent]) => [identity, getWorktreeHostIdentity(parent)])
  )
}

function crossStoreViewOf(
  domains: Pick<SidebarFeedDomains, 'desktop' | 'pairedServerHosts'>,
  rows: ReadonlyMap<string, Worktree>,
  recordByRow: ReadonlyMap<Worktree, unknown>
) {
  const installationIds = new Map<string, string | undefined>([
    [OWN_LINEAGE_STORE_KEY, domains.desktop?.installationId]
  ])
  for (const [hostId, { host }] of domains.pairedServerHosts) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'runtime' && host) {
      installationIds.set(parsed.environmentId, host.installationId ?? undefined)
    }
  }
  return buildCrossStoreLineageViewOfRows(
    [...rows.values()].filter((row) => recordByRow.has(row)),
    (row) => recordByRow.get(row),
    installationIds
  )
}
