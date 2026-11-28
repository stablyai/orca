import { useTranslate } from '@/i18n/use-translate'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace/tabs/workspace-tab-commands'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { isFloatingWorkspaceId } from '../../../../../shared/workspace/identity/floating-workspace-worktree'

/** The floating panel's one tab row shows only the focused split, so a tab in another split needs its own close button. */
export function useFloatingSplitTabClose(
  worktreeId: string,
  resolveTab: (state: AppState) => Tab | undefined
): { onSelect: () => void; label: string } | null {
  const t = useTranslate()
  const tabId = useAppStore((state) => {
    if (
      !isFloatingWorkspaceId(worktreeId) ||
      (state.groupsByWorktree[worktreeId]?.length ?? 0) < 2
    ) {
      return null
    }
    const tab = resolveTab(state)
    return tab && !tab.isPinned ? tab.id : null
  })
  if (tabId === null) {
    return null
  }
  return {
    onSelect: () => {
      dispatchWorkspaceTabCommand({ type: 'close', target: { kind: 'tab', worktreeId, tabId } })
    },
    label: t('auto.components.tab.bar.SortableTab.95db5f2f7d', 'Close tab')
  }
}
