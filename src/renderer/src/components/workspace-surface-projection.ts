import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getCatalogOwnerHostId } from '../lib/worktree-runtime-owner-index'

export type WorkspaceSurface = { id: string; path: string }

type FolderWorkspaceSurfaceRow = Pick<
  FolderWorkspace,
  'id' | 'folderPath' | 'connectionId' | 'executionHostId'
>

/**
 * The row's own host, or null when the row names none.
 *
 * `getCatalogOwnerHostId` defaults an unstamped row to `local`, which is the
 * right answer for an owner lookup but the wrong one for a tie-break: it would
 * let a row that never named a host win the `local` tie and mount another
 * host's path. Only a row that names its own host may claim the collision.
 */
function getStampedFolderWorkspaceHostId(
  workspace: FolderWorkspaceSurfaceRow
): ExecutionHostId | null {
  const namesOwnHost = Boolean(
    parseExecutionHostId(workspace.executionHostId) ?? workspace.connectionId?.trim()
  )
  return namesOwnHost ? getCatalogOwnerHostId(workspace) : null
}

/**
 * The terminal workbench's mount set: exactly one surface per workspace id.
 *
 * Why collapse here and nowhere else: the workbench is bare-id keyed end to end
 * (`activeWorktreeId`, `tabsByWorktree`, `mountedWorktreeIdsRef`, React keys),
 * so it can only represent one surface per id — but both catalogs it reads are
 * host-qualified on purpose (STA-4343), keeping a row per (host, id). Emitting
 * both mounts one workspace's tabs twice under a duplicate React key. Listing
 * surfaces such as the sidebar must keep showing every host.
 *
 * `worktreesById` is the store's first-wins per-id index, and that collapse is
 * lossless: `worktreeId` is `repoId::path`, so colliding rows agree on the path.
 */
export function projectWorkspaceSurfaces({
  worktreesById,
  folderWorkspaces,
  activeWorkspaceId,
  activeWorkspaceResolvedHostId
}: {
  worktreesById: ReadonlyMap<string, Pick<Worktree, 'path'>>
  folderWorkspaces: readonly FolderWorkspaceSurfaceRow[]
  activeWorkspaceId: string | null
  /** Resolved (not user-selected) host of the active workspace; the folder tie-break. */
  activeWorkspaceResolvedHostId: ExecutionHostId | null
}): WorkspaceSurface[] {
  const surfaces: WorkspaceSurface[] = []
  for (const [worktreeId, worktree] of worktreesById) {
    surfaces.push({ id: worktreeId, path: worktree.path })
  }
  const folderSurfaceIndexById = new Map<string, number>()
  for (const workspace of folderWorkspaces) {
    const id = folderWorkspaceKey(workspace.id)
    const surface = { id, path: workspace.folderPath }
    const existingIndex = folderSurfaceIndexById.get(id)
    if (existingIndex === undefined) {
      folderSurfaceIndexById.set(id, surfaces.length)
      surfaces.push(surface)
      continue
    }
    // Why: a folder-workspace id is opaque, not path-derived, so colliding hosts
    // disagree on the path; only the active workspace's resolved host breaks the tie.
    // Deriving that host from the row alone is sufficient because every stored row is
    // stamped with an explicit `executionHostId` by `folderWorkspaceWithFetchedOwner`;
    // an unstamped row keeps first-wins rather than guessing.
    if (
      activeWorkspaceResolvedHostId &&
      id === activeWorkspaceId &&
      getStampedFolderWorkspaceHostId(workspace) === activeWorkspaceResolvedHostId
    ) {
      surfaces[existingIndex] = surface
    } else if (surfaces[existingIndex].path !== surface.path) {
      // The dropped row's path is the PTY cwd for a tab with no startupCwd, so make the
      // unresolvable drop observable rather than silently spawning in the other host's directory.
      console.warn('[workspace-surface] dropping colliding folder path', {
        id,
        kept: surfaces[existingIndex].path,
        dropped: surface.path,
        droppedHost: getCatalogOwnerHostId(workspace)
      })
    }
  }
  return surfaces
}
