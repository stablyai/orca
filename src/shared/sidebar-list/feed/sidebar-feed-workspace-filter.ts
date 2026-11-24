import type { SidebarFeedIndex } from './sidebar-feed-index'
import type { Worktree } from '../../worktree/types'

export function filterSidebarFeedWorkspaces(
  index: SidebarFeedIndex,
  ownsWorktree: ((worktree: Worktree) => boolean) | undefined,
  includeFolders: boolean
): SidebarFeedIndex {
  return !ownsWorktree && includeFolders
    ? index
    : {
        ...index,
        worktrees: ownsWorktree ? index.worktrees.filter(ownsWorktree) : index.worktrees,
        folderWorkspaces: includeFolders ? index.folderWorkspaces : []
      }
}
