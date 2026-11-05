import type { OpenTabPaletteItem } from './worktree-jump-palette-model'
import type { Worktree } from '../../../../shared/worktree/types'

function isCurrentOpenTabItem(item: OpenTabPaletteItem): boolean {
  return item.type === 'browser-page' ? item.result.isCurrentPage : item.result.isCurrentTab
}

// Why: Recent row 1 is Enter's default, so the tab you are on would make "Cmd+J, Enter" a no-op.
export function shouldIncludeOpenTabInRecentSection({
  item,
  worktree
}: {
  item: OpenTabPaletteItem
  worktree: Worktree
}): boolean {
  return !worktree.isArchived && !isCurrentOpenTabItem(item)
}
