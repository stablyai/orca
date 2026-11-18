// Which bot a workspace is under: the nearest bot home its lineage nests it beneath, the sidebar's
// own parent rules, on one host or across this computer and its paired servers.
import type { RuntimeWorktreePsSummary } from '../worktree/catalog/runtime-worktree-contracts'
import {
  buildCrossStoreLineageViewOfRows,
  OWN_LINEAGE_STORE_KEY
} from '../worktree/lineage/cross-store-lineage-resolution'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../worktree/host-qualified-identity'
import { resolveLineageParentsByPolicy } from '../worktree/lineage/workspace-lineage-graph'
import type { Worktree } from '../worktree/types'

/** The nearest row up `parentOf` that `isHome` accepts; parent loops end the walk. */
export function nearestBotHome<Row>(
  row: Row,
  parentOf: (row: Row) => Row | undefined,
  isHome: (row: Row) => boolean
): Row | undefined {
  const seen = new Set<Row>()
  let parent = parentOf(row)
  while (parent && !seen.has(parent)) {
    if (isHome(parent)) {
      return parent
    }
    seen.add(parent)
    parent = parentOf(parent)
  }
  return undefined
}

type PsRow = Pick<Worktree, 'id' | 'hostId' | 'instanceId' | 'isArchived'> & {
  summary: RuntimeWorktreePsSummary
}

/** Every listed store's rows, each host's `worktree.ps` answer with that host's own installationId
 * (`hostId` set on a paired server's rows). */
export type BotOwnerListing = {
  rows: readonly RuntimeWorktreePsSummary[]
  /** The store that answered: undefined for this computer, else the paired server's environment id. */
  environmentId?: string
  /** Absent from hosts that predate it; their rows then parent nothing across stores. */
  installationId?: string
}

/** Names each row's bot by the nearest bot home its lineage reaches, across stores; a row its host
 * already named keeps that name. Bot homes name their own bot. */
export function nameBotOwners(listings: readonly BotOwnerListing[]): RuntimeWorktreePsSummary[] {
  const rows: PsRow[] = listings.flatMap((listing) =>
    listing.rows.map((summary) => ({
      id: summary.worktreeId,
      hostId: summary.hostId,
      instanceId: summary.worktreeInstanceId,
      isArchived: summary.isArchived,
      summary
    }))
  )
  const byIdentity = new Map(rows.map((row) => [getWorktreeHostIdentity(row), row]))
  const parents = resolveLineageParentsByPolicy(byIdentity, {
    sameStoreParentOf: (row) =>
      row.summary.parentWorktreeId
        ? byIdentity.get(composeWorktreeHostIdentity(row.hostId, row.summary.parentWorktreeId))
        : undefined,
    folderRecordOf: (row) => row.summary.workspaceLineage,
    crossStoreLineage: buildCrossStoreLineageViewOfRows(
      rows,
      (row) => row.summary.crossStoreParent,
      new Map(
        listings.map((listing) => [
          listing.environmentId ?? OWN_LINEAGE_STORE_KEY,
          listing.installationId
        ])
      )
    )
  })
  const parentOf = (row: PsRow) => parents.get(getWorktreeHostIdentity(row))
  const isHome = (row: PsRow) => Boolean(row.summary.botHome && row.summary.bot)
  return rows.map((row) => {
    if (row.summary.bot || row.summary.botHome) {
      return row.summary
    }
    const home = nearestBotHome(row, parentOf, isHome)
    return home ? { ...row.summary, bot: home.summary.bot } : row.summary
  })
}
