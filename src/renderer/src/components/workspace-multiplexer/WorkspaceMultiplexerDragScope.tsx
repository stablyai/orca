import { useCallback, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { useAppStore } from '@/store'
import TabDragPreview from '../tab-bar/TabDragPreview'
import { TabDragProvider } from '../tab-group/tab-drag-context'
import { getDragPointer } from '../tab-group/tab-drag-pointer'
import {
  resolvePaneColumnEdgeZone,
  TAB_GROUP_TAB_STRIP_HEIGHT_PX
} from '../tab-group/tab-drop-zone'
import TabPaneColumnSplitDragOverlay from '../tab-group/TabPaneColumnSplitDragOverlay'
import { useTabDragSplit, type TabDropZone } from '../tab-group/useTabDragSplit'
import {
  dropWorkspaceMultiplexerSlot,
  moveWorkspaceMultiplexerSlot
} from './workspace-multiplexer-layout'

export type WorkspaceMultiplexerSlotDragData = {
  kind: 'workspace-multiplexer-slot'
  slotId: string
  paneId: string
  projectName: string
  workspaceName: string
  projectBadgeColor: string | null
}

export type WorkspaceMultiplexerPaneDropData = {
  kind: 'workspace-multiplexer-pane'
  paneId: string
}

export type WorkspaceMultiplexerHoveredDropTarget = {
  paneId: string
  zone: TabDropZone
  panelRect: DOMRect
  targetSlotId?: string
  insertSide?: 'left' | 'right'
}

export function isWorkspaceMultiplexerSlotDragData(
  value: unknown
): value is WorkspaceMultiplexerSlotDragData {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as WorkspaceMultiplexerSlotDragData).kind === 'workspace-multiplexer-slot'
  )
}

function isWorkspaceMultiplexerPaneDropData(
  value: unknown
): value is WorkspaceMultiplexerPaneDropData {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as WorkspaceMultiplexerPaneDropData).kind === 'workspace-multiplexer-pane'
  )
}

function isWorkspaceMultiplexerDropData(value: unknown): boolean {
  return isWorkspaceMultiplexerSlotDragData(value) || isWorkspaceMultiplexerPaneDropData(value)
}

function resolveWorkspaceMultiplexerDropTarget(
  event: DragMoveEvent | DragEndEvent
): WorkspaceMultiplexerHoveredDropTarget | null {
  const activeData = event.active.data.current
  const pointer = getDragPointer(event)
  if (!isWorkspaceMultiplexerSlotDragData(activeData) || !pointer) {
    return null
  }
  const overData = event.over?.data.current
  const paneId =
    isWorkspaceMultiplexerSlotDragData(overData) || isWorkspaceMultiplexerPaneDropData(overData)
      ? overData.paneId
      : null
  const paneElement = Array.from(
    document.querySelectorAll<HTMLElement>('[data-workspace-multiplexer-pane-id]')
  ).find((element) => element.dataset.workspaceMultiplexerPaneId === paneId)
  if (!paneElement || !paneId) {
    return null
  }
  const panelRect = paneElement.getBoundingClientRect()
  const overWorkspaceTab =
    isWorkspaceMultiplexerSlotDragData(overData) && overData.paneId === paneId ? overData : null
  const inTabStrip = pointer.y < panelRect.top + TAB_GROUP_TAB_STRIP_HEIGHT_PX
  const splitDirection =
    overWorkspaceTab && inTabStrip ? null : resolvePaneColumnEdgeZone(panelRect, pointer)
  if (splitDirection) {
    const multiplexer = useAppStore.getState().workspaceMultiplexer
    const sourcePane = multiplexer.panes.find((pane) => pane.id === activeData.paneId)
    if (sourcePane?.id === paneId && sourcePane.slotOrder.length === 1) {
      return null
    }
    return { paneId, zone: splitDirection, panelRect }
  }
  if (!overWorkspaceTab) {
    return { paneId, zone: 'center', panelRect }
  }
  return {
    paneId,
    zone: 'center',
    panelRect,
    targetSlotId: overWorkspaceTab.slotId,
    insertSide: pointer.x < event.over!.rect.left + event.over!.rect.width / 2 ? 'left' : 'right'
  }
}

function WorkspaceMultiplexerDragPreview({
  drag
}: {
  drag: WorkspaceMultiplexerSlotDragData
}): React.JSX.Element {
  return (
    <div className="pointer-events-none flex h-full w-full items-center gap-2 rounded-sm border border-border bg-accent px-2 text-xs text-foreground shadow-md">
      <RepoBadgeMark color={drag.projectBadgeColor} className="size-2 rounded-[2px]" />
      <span className="truncate font-semibold">{drag.projectName}</span>
      <span className="truncate text-muted-foreground">{drag.workspaceName}</span>
    </div>
  )
}

type WorkspaceMultiplexerDragState = ReturnType<typeof useTabDragSplit> & {
  hoveredWorkspaceDropTarget: WorkspaceMultiplexerHoveredDropTarget | null
  moveWorkspaceSlot: (slotId: string, offset: -1 | 1) => void
}

export function WorkspaceMultiplexerDragScope({
  worktreeId,
  onWorkspaceDrop,
  children
}: {
  worktreeId: string
  onWorkspaceDrop: (slotId: string) => void
  children: (drag: WorkspaceMultiplexerDragState) => React.ReactNode
}): React.JSX.Element {
  const drag = useTabDragSplit({ worktreeId, enabled: worktreeId.length > 0 })
  const activeWorkspaceDragRef = useRef<WorkspaceMultiplexerSlotDragData | null>(null)
  const [activeWorkspaceDrag, setActiveWorkspaceDrag] =
    useState<WorkspaceMultiplexerSlotDragData | null>(null)
  const [hoveredWorkspaceDropTarget, setHoveredWorkspaceDropTarget] =
    useState<WorkspaceMultiplexerHoveredDropTarget | null>(null)

  const clearWorkspaceDrag = useCallback(() => {
    activeWorkspaceDragRef.current = null
    setActiveWorkspaceDrag(null)
    setHoveredWorkspaceDropTarget(null)
  }, [])
  const commitWorkspaceMultiplexer = useCallback(
    (next: ReturnType<typeof useAppStore.getState>['workspaceMultiplexer']) => {
      const state = useAppStore.getState()
      if (next !== state.workspaceMultiplexer) {
        state.setWorkspaceMultiplexer(next)
      }
    },
    []
  )
  const moveWorkspaceSlot = useCallback(
    (slotId: string, offset: -1 | 1) => {
      const multiplexer = useAppStore.getState().workspaceMultiplexer
      commitWorkspaceMultiplexer(moveWorkspaceMultiplexerSlot(multiplexer, slotId, offset))
    },
    [commitWorkspaceMultiplexer]
  )
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const workspaceDrag = isWorkspaceMultiplexerSlotDragData(args.active.data.current)
      return drag.collisionDetection({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => isWorkspaceMultiplexerDropData(container.data.current) === workspaceDrag
        )
      })
    },
    [drag]
  )
  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const dragData = event.active.data.current
      if (isWorkspaceMultiplexerSlotDragData(dragData)) {
        activeWorkspaceDragRef.current = dragData
        setActiveWorkspaceDrag(dragData)
        return
      }
      drag.onDragStart(event)
    },
    [drag]
  )
  const onDragMove = useCallback(
    (event: DragMoveEvent) => {
      if (!isWorkspaceMultiplexerSlotDragData(event.active.data.current)) {
        drag.onDragMove(event)
        return
      }
      setHoveredWorkspaceDropTarget(resolveWorkspaceMultiplexerDropTarget(event))
    },
    [drag]
  )
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dragData = event.active.data.current
      if (!isWorkspaceMultiplexerSlotDragData(dragData)) {
        drag.onDragEnd(event)
        return
      }
      const target = resolveWorkspaceMultiplexerDropTarget(event)
      clearWorkspaceDrag()
      if (!target) {
        return
      }
      const multiplexer = useAppStore.getState().workspaceMultiplexer
      const next = dropWorkspaceMultiplexerSlot(multiplexer, dragData.slotId, {
        paneId: target.paneId,
        ...(target.targetSlotId ? { targetSlotId: target.targetSlotId } : {}),
        ...(target.insertSide ? { insertSide: target.insertSide } : {}),
        ...(target.zone === 'center' ? {} : { splitDirection: target.zone })
      })
      commitWorkspaceMultiplexer(next)
      if (next !== multiplexer) {
        onWorkspaceDrop(dragData.slotId)
      }
    },
    [clearWorkspaceDrag, commitWorkspaceMultiplexer, drag, onWorkspaceDrop]
  )
  const onDragCancel = useCallback(() => {
    if (activeWorkspaceDragRef.current) {
      clearWorkspaceDrag()
      return
    }
    drag.onDragCancel()
  }, [clearWorkspaceDrag, drag])

  return (
    <TabDragProvider
      isTabDragActive={drag.activeDrag !== null}
      isTabDragActiveRef={drag.isTabDragActiveRef}
    >
      <DndContext
        sensors={drag.sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragOver={drag.onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        autoScroll={false}
      >
        <div ref={drag.setDragRootNode} className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
          {children({ ...drag, hoveredWorkspaceDropTarget, moveWorkspaceSlot })}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeWorkspaceDrag ? (
            <WorkspaceMultiplexerDragPreview drag={activeWorkspaceDrag} />
          ) : drag.activeDrag ? (
            <TabDragPreview drag={drag.activeDrag} />
          ) : null}
        </DragOverlay>
        {hoveredWorkspaceDropTarget && hoveredWorkspaceDropTarget.zone !== 'center' ? (
          <TabPaneColumnSplitDragOverlay
            panelRect={hoveredWorkspaceDropTarget.panelRect}
            zone={hoveredWorkspaceDropTarget.zone}
          />
        ) : drag.hoveredDropTarget?.zone !== 'center' && drag.hoveredDropTarget?.panelRect ? (
          <TabPaneColumnSplitDragOverlay
            panelRect={drag.hoveredDropTarget.panelRect}
            zone={drag.hoveredDropTarget.zone}
          />
        ) : null}
      </DndContext>
    </TabDragProvider>
  )
}
