import type { TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { isStructuredTab } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import { useAppStore } from '../../../store/index'
import { isQuickCommandEditorOpen } from '../../tab-bar/quick-commands/quick-command-editor-presence'

/** True when every group's active view is drawn outside the layout (terminal, room or structured chat). */
export function layoutHoldsOnlyOverlayViews(
  worktreeId: string,
  groups: readonly TabGroup[]
): boolean {
  if (isQuickCommandEditorOpen(worktreeId)) {
    return false
  }
  const tabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
  const tabById = new Map<string, (typeof tabs)[number]>()
  for (const tab of tabs) {
    if (tab.contentType === 'simulator') {
      return false
    }
    tabById.set(tab.id, tab)
  }
  return groups.every((group) => {
    const active = group.activeTabId ? tabById.get(group.activeTabId) : undefined
    // An empty group shows its landing picker, whose search lives in the layout.
    return (
      active !== undefined &&
      (active.contentType === 'terminal' ||
        active.contentType === 'room' ||
        isStructuredTab(active))
    )
  })
}
