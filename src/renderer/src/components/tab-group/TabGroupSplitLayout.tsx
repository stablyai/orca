import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { TabGroupSplitNodeTree } from './TabGroupSplitNodeTree'
import { WorkspaceTabDragLayer } from './WorkspaceTabDragLayer'

/** The main workspace surface: the shared drag scope and group tree under main-window chrome
 *  (drag strip, left seam border). Hosts with their own chrome compose the two parts directly. */
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
  return (
    <WorkspaceTabDragLayer worktreeId={worktreeId} enabled={isWorktreeActive}>
      {({ isTabDragActive, hoveredTabInsertion, setDragRootNode }) => (
        /* Why: the 10px drag strip sits ABOVE the split layout — lifted out of
          each pane — so vertical split resize handles don't extend into the
          window-drag region at the top. Only the split layout's own panes
          own the resize handles, while this strip keeps the whole top of the
          center column draggable regardless of how the splits are arranged.
          Why 4px specifically: pairs with the 32px tab row below so the
          total top-band is 36px, matching the sibling `titlebar-left` above
          the sidebar. Keep this small — it's just enough drag surface above
          the tabs without opening a visible gap between the window top and
          the tab chrome. Without this, the tab row's bottom border falls short
          of the sidebar header's and the seam between columns reads as off.
          Why `border-l` on the wrapper: paint the single full-height divider
          between the left sidebar and the terminal area, regardless of split
          state. The leftmost pane suppresses its own `border-l` via
          `touchesLeftEdge`, so the seam is always exactly 1px — previously
          both painted and stacked into a 2px bar below the drag strip. */
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
              isTabDragActive={isTabDragActive}
              hoveredTabInsertion={hoveredTabInsertion}
            />
          </div>
        </div>
      )}
    </WorkspaceTabDragLayer>
  )
}
