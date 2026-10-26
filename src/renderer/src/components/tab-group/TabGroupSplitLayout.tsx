import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { useClientHostedBrowserRows } from '@/lib/pane-manager/client-hosted-browser-row-state'
import { isAutoHideSingleTabStripEnabled } from './auto-hide-single-tab-strip-preference'
import { areAllTabStripsAutoHidden } from './single-tab-strip-visibility'
import { TabGroupSplitNodeTree } from './TabGroupSplitNodeTree'
import { WorkspaceTabDragLayer } from './WorkspaceTabDragLayer'

// Why: stable fallbacks — a fresh `?? []` breaks Zustand v5 snapshot identity and loops renders.
const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []

/** Compose main-window chrome around the shared drag scope/tree; other hosts supply their own chrome. */
export default function TabGroupSplitLayout({
  layout,
  worktreeId,
  focusedGroupId,
  isWorktreeActive
}: {
  layout: TabGroupLayoutNode
  worktreeId: string
  focusedGroupId?: string
  isWorktreeActive: boolean
}): React.JSX.Element {
  const clientHostedRowCount = useClientHostedBrowserRows(worktreeId).length
  const allStripsAutoHidden = useAppStore((state) => {
    // Why: off is the default and this runs on every store update, so skip the tab scan entirely.
    if (!isAutoHideSingleTabStripEnabled(state.settings)) {
      return false
    }
    const groups = state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS
    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS
    return areAllTabStripsAutoHidden({
      autoHideEnabled: true,
      groupTabCounts: groups.map((group) => tabs.filter((tab) => tab.groupId === group.id).length),
      clientHostedRowCount
    })
  })

  return (
    <WorkspaceTabDragLayer worktreeId={worktreeId} enabled={isWorktreeActive}>
      {({ isTabDragActive, hoveredTabInsertion, setDragRootNode }) => (
        /* Keep the 4px drag strip outside resize panes to align the 36px header; the wrapper owns the single sidebar seam. */
        <div
          ref={setDragRootNode}
          className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden border-l border-border"
        >
          {/* Why: with every strip collapsed there is no 32px row to pair with, and the band is left
            reading as a stray 4px ledge above the pane — drop it and let the pane reach the window edge. */}
          {allStripsAutoHidden ? null : (
            <div className="h-[4px] shrink-0 bg-card" data-terminal-focus-release-surface="true" />
          )}
          <div className="flex flex-1 min-w-0 min-h-0 overflow-hidden">
            <TabGroupSplitNodeTree
              layout={layout}
              worktreeId={worktreeId}
              focusedGroupId={focusedGroupId}
              isWorktreeActive={isWorktreeActive}
              isTabDragActive={isTabDragActive}
              hoveredTabInsertion={hoveredTabInsertion}
            />
          </div>
        </div>
      )}
    </WorkspaceTabDragLayer>
  )
}
