import type { ActivityBarItem } from './activity-bar-buttons'

type RightSidebarActivityVisibilityState = {
  hasReviewNotes: boolean
  isFolder: boolean
  isFolderWorkspace: boolean
  isSshRepo: boolean
}

export function getVisibleRightSidebarActivityItems(
  items: ActivityBarItem[],
  { hasReviewNotes, isFolder, isFolderWorkspace, isSshRepo }: RightSidebarActivityVisibilityState
): ActivityBarItem[] {
  return items.filter(
    (item) =>
      (!item.gitOnly || !isFolder || (item.id === 'source-control' && hasReviewNotes)) &&
      (!item.folderOnly || isFolderWorkspace) &&
      (!item.sshOnly || isSshRepo)
  )
}
