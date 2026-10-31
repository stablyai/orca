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

/** Only explicitly named hosts may win collisions; default-local owner lookup would let unstamped rows mount another host’s path. */
function getStampedFolderWorkspaceHostId(
  workspace: FolderWorkspaceSurfaceRow
): ExecutionHostId | null {
  const namesOwnHost = Boolean(
    parseExecutionHostId(workspace.executionHostId) ?? workspace.connectionId?.trim()
  )
  return namesOwnHost ? getCatalogOwnerHostId(workspace) : null
}

/** Workbench state/keys support one surface per bare workspace ID, unlike host-qualified listing catalogs (STA-4343). Collapse only here; Git IDs encode repo/path so first-wins is lossless. */
export function projectWorkspaceSurfaces({
  worktreesById,
  folderWorkspaces,
  activeWorkspaceId,
  activeWorkspaceResolvedHostId
}: {
  worktreesById: ReadonlyMap<string, Pick<Worktree, 'path'>>
  folderWorkspaces: readonly FolderWorkspaceSurfaceRow[]
  /** Read only when `activeWorkspaceResolvedHostId` is set; inert otherwise. */
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
    // Opaque folder IDs can collide across paths; use the active resolved host, requiring explicit row host identity, otherwise retain first-wins.
    if (
      activeWorkspaceResolvedHostId &&
      id === activeWorkspaceId &&
      getStampedFolderWorkspaceHostId(workspace) === activeWorkspaceResolvedHostId
    ) {
      surfaces[existingIndex] = surface
    } else if (surfaces[existingIndex].path !== surface.path) {
      // Report unresolved path drops: that path becomes PTY cwd when no startupCwd exists.
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
