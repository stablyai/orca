import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { TabGroupSplitNodeTree } from './TabGroupSplitNodeTree'
import { WorkspaceTabDragLayer } from './WorkspaceTabDragLayer'

/** Compose main-window chrome around the shared drag scope/tree; other hosts supply their own chrome. */
export default function TabGroupSplitLayout({
  layout,
  worktreeId,
  focusedGroupId,
  isWorktreeActive,
  isWorktreeFocused = isWorktreeActive,
  touchesWindowTop = true
}: {
  layout: TabGroupLayoutNode
  worktreeId: string
  focusedGroupId?: string
  isWorktreeActive: boolean
  isWorktreeFocused?: boolean
  touchesWindowTop?: boolean
}): React.JSX.Element {
  return (
    <WorkspaceTabDragLayer worktreeId={worktreeId} enabled={isWorktreeActive}>
      {({ isTabDragActive, hoveredTabInsertion, setDragRootNode }) => (
        /* Keep the 4px drag strip outside resize panes to align the 36px header; the wrapper owns the single sidebar seam. */
        <div
          ref={setDragRootNode}
          className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden border-l border-border"
        >
          <div className="h-[4px] shrink-0 bg-card" data-terminal-focus-release-surface="true" />
          <div className="flex flex-1 min-w-0 min-h-0 overflow-hidden">
            <TabGroupSplitNodeTree
              layout={layout}
              worktreeId={worktreeId}
              focusedGroupId={focusedGroupId}
              isWorktreeActive={isWorktreeActive}
              isWorktreeFocused={isWorktreeFocused}
              isTabDragActive={isTabDragActive}
              hoveredTabInsertion={hoveredTabInsertion}
              rootTouchesTopEdge={touchesWindowTop}
            />
          </div>
        </div>
      )}
    </WorkspaceTabDragLayer>
  )
}
