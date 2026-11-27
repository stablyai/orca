import 'react'
import type { TabGroupLayoutNode } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { useAppStore } from '../../store/index'
import TabGroupPanel, { type TabGroupPanelTabStrip } from './TabGroupPanel'
import type { HoveredTabInsertion } from './drag/tab-insertion'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { setGroupRatioThroughLayoutOwner } from '../../runtime/workspace-layout/commands/tab-group-layout-owner-commands'
import '../browser-pane/host-guest/drag/webview-drag-passthrough'

import { ResizeHandle } from '../pane-resize/PaneSplitResizeHandle'

function SplitNode({
  node,
  nodePath,
  worktreeId,
  focusedGroupId,
  isWorktreeActive,
  hasSplitGroups,
  tabStrip,
  markdownAnnotationsEnabled,
  touchesTopEdge,
  touchesRightEdge,
  touchesLeftEdge,
  touchesBottomEdge,
  suppressLeftBorder,
  suppressRightBorder,
  suppressBottomBorder,
  isTabDragActive,
  hoveredTabInsertion
}: {
  node: TabGroupLayoutNode
  nodePath: string
  worktreeId: string
  focusedGroupId?: string
  isWorktreeActive: boolean
  hasSplitGroups: boolean
  tabStrip: TabGroupPanelTabStrip
  markdownAnnotationsEnabled: boolean
  touchesTopEdge: boolean
  touchesRightEdge: boolean
  touchesLeftEdge: boolean
  touchesBottomEdge: boolean
  suppressLeftBorder: boolean
  suppressRightBorder: boolean
  suppressBottomBorder: boolean
  isTabDragActive: boolean
  hoveredTabInsertion: HoveredTabInsertion | null
}): React.JSX.Element {
  const setTabGroupSplitRatio = useAppStore((state) => state.setTabGroupSplitRatio)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  if (node.type === 'leaf') {
    return (
      <TabGroupPanel
        groupId={node.groupId}
        worktreeId={worktreeId}
        isVisible={isWorktreeActive}
        // Retain hidden PTYs/layouts, but grant global terminal shortcuts only to the visible focused group.
        isFocused={isWorktreeActive && node.groupId === focusedGroupId}
        hasSplitGroups={hasSplitGroups}
        tabStrip={tabStrip}
        markdownAnnotationsEnabled={markdownAnnotationsEnabled}
        touchesRightEdge={touchesRightEdge}
        touchesLeftEdge={touchesLeftEdge}
        touchesBottomEdge={touchesBottomEdge}
        suppressLeftBorder={suppressLeftBorder}
        suppressRightBorder={suppressRightBorder}
        suppressBottomBorder={suppressBottomBorder}
        reserveClosedExplorerToggleSpace={touchesTopEdge && touchesRightEdge}
        reserveCollapsedSidebarHeaderSpace={touchesTopEdge && touchesLeftEdge}
        isTabDragActive={isTabDragActive}
        hoveredTabInsertion={
          hoveredTabInsertion?.groupId === node.groupId ? hoveredTabInsertion : null
        }
      />
    )
  }

  const isHorizontal = node.direction === 'horizontal'
  const ratio = node.ratio ?? 0.5

  return (
    <div
      className="flex flex-1 min-w-0 min-h-0 overflow-hidden"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div className="flex min-w-0 min-h-0 overflow-hidden" style={{ flex: `${ratio} 1 0%` }}>
        <SplitNode
          node={node.first}
          nodePath={nodePath.length > 0 ? `${nodePath}.first` : 'first'}
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          isWorktreeActive={isWorktreeActive}
          hasSplitGroups={hasSplitGroups}
          tabStrip={tabStrip}
          markdownAnnotationsEnabled={markdownAnnotationsEnabled}
          touchesTopEdge={touchesTopEdge}
          touchesRightEdge={isHorizontal ? false : touchesRightEdge}
          touchesLeftEdge={touchesLeftEdge}
          touchesBottomEdge={isHorizontal ? touchesBottomEdge : false}
          suppressLeftBorder={suppressLeftBorder}
          // The resize handle owns the inner seam; pane borders would stack into extra lines.
          suppressRightBorder={isHorizontal ? true : suppressRightBorder}
          suppressBottomBorder={isHorizontal ? suppressBottomBorder : true}
          isTabDragActive={isTabDragActive}
          hoveredTabInsertion={hoveredTabInsertion}
        />
      </div>
      <ResizeHandle
        direction={node.direction}
        thin
        avoidTabRows={isHorizontal && tabStrip === 'attached'}
        layoutKey={node.second}
        onResizeStart={() => recordFeatureInteraction('terminal-panes')}
        onRatioChange={(nextRatio) =>
          ORCA_LAYOUT_OWNER_IS_MAIN
            ? setGroupRatioThroughLayoutOwner(worktreeId, nodePath, nextRatio)
            : setTabGroupSplitRatio(worktreeId, nodePath, nextRatio)
        }
      />
      <div className="flex min-w-0 min-h-0 overflow-hidden" style={{ flex: `${1 - ratio} 1 0%` }}>
        <SplitNode
          node={node.second}
          nodePath={nodePath.length > 0 ? `${nodePath}.second` : 'second'}
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          isWorktreeActive={isWorktreeActive}
          hasSplitGroups={hasSplitGroups}
          tabStrip={tabStrip}
          markdownAnnotationsEnabled={markdownAnnotationsEnabled}
          touchesTopEdge={isHorizontal ? touchesTopEdge : false}
          touchesRightEdge={touchesRightEdge}
          touchesLeftEdge={isHorizontal ? false : touchesLeftEdge}
          touchesBottomEdge={touchesBottomEdge}
          suppressLeftBorder={isHorizontal ? true : suppressLeftBorder}
          suppressRightBorder={suppressRightBorder}
          suppressBottomBorder={suppressBottomBorder}
          isTabDragActive={isTabDragActive}
          hoveredTabInsertion={hoveredTabInsertion}
        />
      </div>
    </div>
  )
}

/** Host this chrome-free tree in a sized flex container or panes collapse; the host owns drag scope and outer seams. */
export function TabGroupSplitNodeTree({
  layout,
  worktreeId,
  focusedGroupId,
  isWorktreeActive,
  isTabDragActive,
  hoveredTabInsertion,
  tabStrip = 'attached',
  markdownAnnotationsEnabled = true,
  rootTouchesBottomEdge = false
}: {
  layout: TabGroupLayoutNode
  worktreeId: string
  focusedGroupId?: string
  isWorktreeActive: boolean
  isTabDragActive: boolean
  hoveredTabInsertion: HoveredTabInsertion | null
  tabStrip?: TabGroupPanelTabStrip
  /** Off for scratch workspaces (the floating panel) whose markdown is not a review surface. */
  markdownAnnotationsEnabled?: boolean
  /** True when the host's own chrome bounds the tree's bottom edge (no border-b to paint). */
  rootTouchesBottomEdge?: boolean
}): React.JSX.Element {
  return (
    <SplitNode
      node={layout}
      nodePath=""
      worktreeId={worktreeId}
      focusedGroupId={focusedGroupId}
      isWorktreeActive={isWorktreeActive}
      hasSplitGroups={layout.type === 'split'}
      tabStrip={tabStrip}
      markdownAnnotationsEnabled={markdownAnnotationsEnabled}
      touchesTopEdge={true}
      touchesRightEdge={true}
      touchesLeftEdge={true}
      touchesBottomEdge={rootTouchesBottomEdge}
      suppressLeftBorder={false}
      suppressRightBorder={false}
      suppressBottomBorder={false}
      isTabDragActive={isTabDragActive}
      hoveredTabInsertion={hoveredTabInsertion}
    />
  )
}
