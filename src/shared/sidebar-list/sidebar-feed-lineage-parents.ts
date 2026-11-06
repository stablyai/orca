import { parseExecutionHostId } from '../execution-host'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import {
  buildCrossStoreLineageViewOfRows,
  OWN_LINEAGE_STORE_KEY
} from '../worktree/cross-store-lineage-resolution'
import type { Worktree } from '../worktree/types'
import type { SidebarFeedDomains } from './sidebar-feed-domains'
import type { SidebarFeedWorkspace } from './sidebar-feed-worktrees'
import {
  resolveSidebarLineageParentIdentities,
  type SidebarLineageParentIdentities
} from './worktree-lineage-projection'

const NO_LINEAGE_MAP = {}

/** Parents over every feed row, cross-store ones included; undefined while no row carries a
 * cross-store record, so the builder nests exactly as before. Store identities are the host's own
 * (desktop facts) and each paired server's as the host verified it. */
export function resolveFeedLineageParentIdentities(
  domains: Pick<SidebarFeedDomains, 'desktop' | 'pairedServerHosts'>,
  workspaces: readonly SidebarFeedWorkspace[]
): SidebarLineageParentIdentities | undefined {
  const recordByRow = new Map<Worktree, unknown>()
  for (const entry of workspaces) {
    if (entry.crossStoreParent && !entry.folderWorkspace) {
      recordByRow.set(entry.worktree, entry.crossStoreParent)
    }
  }
  if (recordByRow.size === 0) {
    return undefined
  }
  const installationIds = new Map<string, string | undefined>([
    [OWN_LINEAGE_STORE_KEY, domains.desktop?.installationId]
  ])
  for (const [hostId, { host }] of domains.pairedServerHosts) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'runtime' && host) {
      installationIds.set(parsed.environmentId, host.installationId ?? undefined)
    }
  }
  const rows = workspaces.flatMap((entry) => (entry.folderWorkspace ? [] : [entry.worktree]))
  return resolveSidebarLineageParentIdentities(
    NO_LINEAGE_MAP,
    new Map(rows.map((row) => [getWorktreeHostIdentity(row), row])),
    buildCrossStoreLineageViewOfRows(rows, (row) => recordByRow.get(row), installationIds)
  )
}
