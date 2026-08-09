import type { ActivityBarItem } from './activity-bar-buttons'

type RightSidebarActivityVisibilityState = {
  isFolder: boolean
  isFolderWorkspace: boolean
  isSshRepo: boolean
  hasLinkedLinearIssue: boolean
}

export function getVisibleRightSidebarActivityItems(
  items: ActivityBarItem[],
  {
    isFolder,
    isFolderWorkspace,
    isSshRepo,
    hasLinkedLinearIssue
  }: RightSidebarActivityVisibilityState
): ActivityBarItem[] {
  return items.filter((item) => {
    if (item.gitOnly && isFolder) {
      return false
    }
    if (item.folderOnly && !isFolderWorkspace) {
      return false
    }
    if (item.sshOnly && !isSshRepo) {
      return false
    }
    if (item.linearOnly && !hasLinkedLinearIssue) {
      return false
    }
    return true
  })
}
