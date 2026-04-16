import { useCallback, useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import { useAppStore } from '../../store'
import TabGroupPanel from './TabGroupPanel'
import { type TabDropZone, useTabDragSplit } from './useTabDragSplit'

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

function ResizeHandle({
  direction,
  onRatioChange
}: {
  direction: 'horizontal' | 'vertical'
  onRatioChange: (ratio: number) => void
}): React.JSX.Element {
  const isHorizontal = direction === 'horizontal'
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) {
        return
      }
      setDragging(true)
      handle.setPointerCapture(event.pointerId)

      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (!handle.hasPointerCapture(event.pointerId)) {
          return
        }
        const rect = container.getBoundingClientRect()
        const ratio = isHorizontal
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height
        onRatioChange(Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)))
      }

      const cleanup = (): void => {
        setDragging(false)
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId)
        }
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', onPointerUp)
        handle.removeEventListener('pointercancel', onPointerCancel)
        handle.removeEventListener('lostpointercapture', onLostPointerCapture)
      }

      const onPointerUp = (): void => {
        cleanup()
      }

      const onPointerCancel = (): void => {
        cleanup()
      }

      const onLostPointerCapture = (): void => {
        cleanup()
      }

      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', onPointerUp)
      handle.addEventListener('pointercancel', onPointerCancel)
      handle.addEventListener('lostpointercapture', onLostPointerCapture)
    },
    [isHorizontal, onRatioChange]
  )

  return (
    <div
      className={`shrink-0 ${
        isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      } ${dragging ? 'bg-accent' : 'bg-border hover:bg-accent/50'}`}
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
  touchesTopEdge,
  touchesRightEdge,
  touchesLeftEdge,
  isTabDragActive,
  activeDropGroupId,
  activeDropZone
}: {
  node: TabGroupLayoutNode
  nodePath: string
  worktreeId: string
  focusedGroupId?: string
  isWorktreeActive: boolean
  hasSplitGroups: boolean
  touchesTopEdge: boolean
  touchesRightEdge: boolean
  touchesLeftEdge: boolean
  isTabDragActive: boolean
  activeDropGroupId: string | null
  activeDropZone: TabDropZone | null
}): React.JSX.Element {
  const setTabGroupSplitRatio = useAppStore((state) => state.setTabGroupSplitRatio)

  if (node.type === 'leaf') {
    return (
      <TabGroupPanel
        groupId={node.groupId}
        worktreeId={worktreeId}
        // Why: hidden worktrees stay mounted so their PTYs and split layouts
        // survive worktree switches, but only the visible worktree may own the
        // global terminal shortcuts. If an offscreen group's pane stays
        // "focused", Cmd/Ctrl+W and split shortcuts can hit the wrong worktree.
        isFocused={isWorktreeActive && node.groupId === focusedGroupId}
        hasSplitGroups={hasSplitGroups}
        reserveClosedExplorerToggleSpace={touchesTopEdge && touchesRightEdge}
        reserveCollapsedSidebarHeaderSpace={touchesTopEdge && touchesLeftEdge}
        isTabDragActive={isTabDragActive}
        activeDropZone={activeDropGroupId === node.groupId ? activeDropZone : null}
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
          touchesTopEdge={touchesTopEdge}
          touchesRightEdge={isHorizontal ? false : touchesRightEdge}
          touchesLeftEdge={touchesLeftEdge}
          isTabDragActive={isTabDragActive}
          activeDropGroupId={activeDropGroupId}
          activeDropZone={activeDropZone}
        />
      </div>
      <ResizeHandle
        direction={node.direction}
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
          touchesTopEdge={isHorizontal ? touchesTopEdge : false}
          touchesRightEdge={touchesRightEdge}
          touchesLeftEdge={isHorizontal ? false : touchesLeftEdge}
          isTabDragActive={isTabDragActive}
          activeDropGroupId={activeDropGroupId}
          activeDropZone={activeDropZone}
        />
      </div>
    </div>
  )
}

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
  const dragSplit = useTabDragSplit({ worktreeId, enabled: isWorktreeActive })

  return (
    <DndContext
      sensors={dragSplit.sensors}
      collisionDetection={dragSplit.collisionDetection}
      onDragStart={dragSplit.onDragStart}
      onDragMove={dragSplit.onDragMove}
      onDragOver={dragSplit.onDragOver}
      onDragEnd={dragSplit.onDragEnd}
      onDragCancel={dragSplit.onDragCancel}
    >
      <div className="flex flex-1 min-w-0 min-h-0 overflow-hidden">
        <SplitNode
          node={layout}
          nodePath=""
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          isWorktreeActive={isWorktreeActive}
          hasSplitGroups={layout.type === 'split'}
          touchesTopEdge={true}
          touchesRightEdge={true}
          touchesLeftEdge={true}
          isTabDragActive={dragSplit.activeDrag !== null}
          activeDropGroupId={dragSplit.hoveredDropTarget?.groupId ?? null}
          activeDropZone={dragSplit.hoveredDropTarget?.zone ?? null}
        />
      </div>
    </DndContext>
  )
}
