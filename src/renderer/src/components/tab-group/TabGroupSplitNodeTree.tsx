import { useCallback, useEffect, useRef, useState } from 'react'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import TabGroupPanel, { type TabGroupPanelTabStrip } from './TabGroupPanel'
import type { HoveredTabInsertion } from './useTabDragSplit'

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

function ResizeHandle({
  direction,
  onResizeStart,
  onRatioChange
}: {
  direction: 'horizontal' | 'vertical'
  onResizeStart: () => void
  onRatioChange: (ratio: number) => void
}): React.JSX.Element {
  const isHorizontal = direction === 'horizontal'
  const [dragging, setDragging] = useState(false)
  const activeResizeCleanupRef = useRef<((updateDragging?: boolean) => void) | null>(null)

  useEffect(
    () => () => {
      activeResizeCleanupRef.current?.(false)
    },
    []
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      // Why: a second pointer must not steal or finalize the active gesture.
      if (activeResizeCleanupRef.current) {
        return
      }
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) {
        return
      }
      const firstPane = handle.previousElementSibling as HTMLElement | null
      const secondPane = handle.nextElementSibling as HTMLElement | null
      if (!firstPane || !secondPane) {
        return
      }
      onResizeStart()
      setDragging(true)
      handle.setPointerCapture(event.pointerId)
      // Why: measure outside pointermove so pane writes never force a readback.
      let rect = container.getBoundingClientRect()
      const resizeObserver = new ResizeObserver(() => {
        rect = container.getBoundingClientRect()
      })
      resizeObserver.observe(container)
      let draggedRatio: number | null = null

      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== event.pointerId || !handle.hasPointerCapture(event.pointerId)) {
          return
        }
        const ratio = isHorizontal
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height
        const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
        draggedRatio = clamped
        // Why: direct style writes keep the drag off the store — a commit per
        // pointermove published 60-120 global store updates/s against every
        // subscriber (STA-3328). React re-applies identical flex on commit.
        firstPane.style.flex = `${clamped} 1 0%`
        secondPane.style.flex = `${1 - clamped} 1 0%`
      }

      let cleaned = false
      const cleanup = (updateDragging = true): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        resizeObserver.disconnect()
        if (draggedRatio !== null) {
          onRatioChange(draggedRatio)
        }
        if (updateDragging) {
          setDragging(false)
        }
        try {
          if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId)
          }
        } catch {
          // Best effort: unmount cleanup can run after Chromium has already dropped capture.
        }
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', onPointerUp)
        handle.removeEventListener('pointercancel', onPointerCancel)
        handle.removeEventListener('lostpointercapture', onLostPointerCapture)
        if (activeResizeCleanupRef.current === cleanup) {
          activeResizeCleanupRef.current = null
        }
      }

      const onPointerUp = (upEvent: PointerEvent): void => {
        if (upEvent.pointerId === event.pointerId) {
          cleanup()
        }
      }

      const onPointerCancel = (cancelEvent: PointerEvent): void => {
        if (cancelEvent.pointerId === event.pointerId) {
          cleanup()
        }
      }

      const onLostPointerCapture = (lostEvent: PointerEvent): void => {
        if (lostEvent.pointerId === event.pointerId) {
          cleanup()
        }
      }

      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', onPointerUp)
      handle.addEventListener('pointercancel', onPointerCancel)
      handle.addEventListener('lostpointercapture', onLostPointerCapture)
      activeResizeCleanupRef.current = cleanup
    },
    [isHorizontal, onRatioChange, onResizeStart]
  )

  return (
    <div
      className={`tab-group-split-resize-handle ${
        isHorizontal ? 'is-vertical' : 'is-horizontal'
      }${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
    />
  )
}

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
        // Why: hidden worktrees stay mounted so their PTYs and split layouts
        // survive worktree switches, but only the visible worktree may own the
        // global terminal shortcuts. If an offscreen group's pane stays
        // "focused", Cmd/Ctrl+W and split shortcuts can hit the wrong worktree.
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
          // Why: the resize handle paints the inner seam — pane borders here
          // stack into a triple-line bar beside the divider.
          suppressRightBorder={isHorizontal ? true : suppressRightBorder}
          suppressBottomBorder={isHorizontal ? suppressBottomBorder : true}
          isTabDragActive={isTabDragActive}
          hoveredTabInsertion={hoveredTabInsertion}
        />
      </div>
      <ResizeHandle
        direction={node.direction}
        onResizeStart={() => recordFeatureInteraction('terminal-panes')}
        onRatioChange={(nextRatio) => setTabGroupSplitRatio(worktreeId, nodePath, nextRatio)}
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

/**
 * The chrome-free group tree: recursive splits, resize handles, and one TabGroupPanel per leaf.
 * The host owns the drag scope (WorkspaceTabDragLayer), outer chrome, and edge policy.
 *
 * Host contract: the tree's nodes size themselves as flex items (`flex-1`), so the host must
 * mount it in a flex container that owns its rect (WorktreeSplitSurface's `absolute inset-0
 * flex`, the floating panel's surface frame). In a block parent every pane collapses to 0px.
 */
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
