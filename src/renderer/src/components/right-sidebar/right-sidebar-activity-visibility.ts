import type { ActivityBarItem } from './activity-bar-buttons'

export function getVisibleRightSidebarActivityItems(
  items: ActivityBarItem[],
  {
    isFolder,
    isSshRepo
  }: {
    isFolder: boolean
    isSshRepo: boolean
  }
): ActivityBarItem[] {
  return items.filter((item) => {
    if (item.gitOnly && isFolder) {
      return false
    }
    if (item.sshOnly && !isSshRepo) {
      return false
    }
    return true
  })
}
