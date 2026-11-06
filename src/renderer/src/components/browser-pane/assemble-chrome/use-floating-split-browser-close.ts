import { translate } from '@/i18n/i18n'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser-workspace-source-resolution'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { useAppStore } from '@/store'
import { isFloatingWorkspaceId } from '../../../../../shared/floating-workspace-worktree'
import type { BrowserChromeToolAction } from './browser-chrome-toolbar'

/** The floating panel's one tab row shows only the focused split, so a browser in another split needs its own close button. */
export function useFloatingSplitBrowserClose(
  worktreeId: string,
  browserPageId: string
): BrowserChromeToolAction | null {
  const tabId = useAppStore((state) => {
    if (
      !isFloatingWorkspaceId(worktreeId) ||
      (state.groupsByWorktree[worktreeId]?.length ?? 0) < 2
    ) {
      return null
    }
    const tab = resolveBrowserSourceUnifiedTab(state, browserPageId, worktreeId)
    return tab && !tab.isPinned ? tab.id : null
  })
  if (tabId === null) {
    return null
  }
  return {
    onSelect: () => {
      dispatchWorkspaceTabCommand({ type: 'close', target: { kind: 'tab', worktreeId, tabId } })
    },
    label: translate('auto.components.tab.bar.SortableTab.95db5f2f7d', 'Close tab')
  }
}
