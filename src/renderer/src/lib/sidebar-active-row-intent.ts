export type SidebarActiveRowIntent = {
  worktreeId: string
  rowKey: string
  navigationIntent: number
}

export function reconcileSidebarActiveRowIntent(
  intent: SidebarActiveRowIntent | null,
  currentNavigationIntent: number,
  rowStillVisible: boolean
): SidebarActiveRowIntent | null {
  if (intent === null || intent.navigationIntent !== currentNavigationIntent || !rowStillVisible) {
    return null
  }
  return intent
}
