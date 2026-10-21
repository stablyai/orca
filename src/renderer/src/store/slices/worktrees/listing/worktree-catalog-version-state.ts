import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  isWorktreeCatalogVersion,
  isWorktreeCatalogVersionBefore,
  laterWorktreeCatalogVersion,
  type WorktreeCatalogVersion
} from '../../../../../../shared/worktree/catalog-version'
import type { AppState } from '../../../types'

/**
 * The client's side of catalog ordering: the newest version it has applied per repo and host.
 *
 * A listing is a snapshot from when its scan began. Anything that delays it past a create or
 * remove reply -- host post-scan work, a coalesced joiner, the pre-merge terminal teardown -- would
 * otherwise let it undo that reply. Comparing versions at apply time is what makes the order the
 * publications arrived in irrelevant.
 */

export type WorktreeCatalogVersionState = Pick<AppState, 'worktreeCatalogVersionByRepoHost'>

export function worktreeCatalogVersionKey(repoId: string, hostId: ExecutionHostId): string {
  return `${repoId}\0${hostId}`
}

/** A publication older than one already applied for this repo and host must not be applied. */
export function isStaleWorktreeCatalogPublication(
  state: WorktreeCatalogVersionState,
  repoId: string,
  hostId: ExecutionHostId,
  version: WorktreeCatalogVersion | undefined
): boolean {
  if (!isWorktreeCatalogVersion(version)) {
    // Why: a host that predates the stamp, or sends a shape this client cannot order, gets today's
    // behavior; the field is optional on the wire.
    return false
  }
  const applied = state.worktreeCatalogVersionByRepoHost[worktreeCatalogVersionKey(repoId, hostId)]
  return applied !== undefined && isWorktreeCatalogVersionBefore(version, applied)
}

/** The state patch that records `version` as applied, or nothing when it moves nothing. */
export function appliedWorktreeCatalogVersionPatch(
  state: WorktreeCatalogVersionState,
  repoId: string,
  hostId: ExecutionHostId,
  version: WorktreeCatalogVersion | undefined
): Partial<WorktreeCatalogVersionState> {
  if (!isWorktreeCatalogVersion(version)) {
    return {}
  }
  const key = worktreeCatalogVersionKey(repoId, hostId)
  const applied = state.worktreeCatalogVersionByRepoHost[key]
  const next = laterWorktreeCatalogVersion(applied, version)
  if (next === applied) {
    return {}
  }
  return {
    worktreeCatalogVersionByRepoHost: { ...state.worktreeCatalogVersionByRepoHost, [key]: next }
  }
}
