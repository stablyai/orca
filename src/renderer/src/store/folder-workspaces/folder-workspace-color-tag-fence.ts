import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { normalizeWorkspaceColorTag } from '../../../../shared/workspace-color-tag'
import { MetaWriteFence } from '../slices/worktrees/metadata/worktree-meta-write-fence'
import { getFolderWorkspaceHostId } from './folder-workspace-catalog'

/**
 * Why a fence for folders too: the folder catalog merges wholesale, and folder writes have no
 * optimistic store apply, so a listing captured before a color write and merged after it restored
 * the old color until a later refresh. Same fence the git rows use, keyed by folder id and owner
 * host; a held listing earns one refresh after the write lands.
 */
export const folderColorTagWriteFence = new MetaWriteFence()

/**
 * Keeps the current color of any merged row whose write the listing predates. Returns `merged`
 * itself when nothing is held: the catalog actions compare the array by reference to decide whether
 * a refetch changed anything.
 */
export function preserveFencedFolderColorTags(
  merged: readonly FolderWorkspace[],
  previous: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[],
  fetchStartedAt: number
): readonly FolderWorkspace[] {
  let result: FolderWorkspace[] | undefined
  merged.forEach((workspace, index) => {
    const hostId = getFolderWorkspaceHostId(workspace, projectGroups)
    const current = previous.find(
      (candidate) =>
        candidate.id === workspace.id &&
        getFolderWorkspaceHostId(candidate, projectGroups) === hostId
    )
    if (!current) {
      return
    }
    const incoming = normalizeWorkspaceColorTag(workspace.colorTag)
    if (incoming === normalizeWorkspaceColorTag(current.colorTag)) {
      return
    }
    if (
      folderColorTagWriteFence.isPending(
        workspace.id,
        hostId,
        fetchStartedAt,
        undefined,
        undefined,
        incoming
      )
    ) {
      result ??= [...merged]
      result[index] = { ...workspace, colorTag: current.colorTag }
    }
  })
  return result ?? merged
}
