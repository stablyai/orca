import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { useVirtualizer, type Range } from '@tanstack/react-virtual'
import type { Repo } from '../../../../shared/repo-types'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/worktree/types'
import type { WorkspaceKanbanLaneView } from './workspace-kanban-search'
import { useStagedMountPerFrame } from '@/lib/use-staged-mount-per-frame'
import { extractVirtualRangeWithFocusedIndex } from './virtual-range-with-focused-index'
import WorkspaceKanbanStatusLane from './WorkspaceKanbanStatusLane'

// Why: a fresh [] per render would defeat the memoized lane on empty lanes.
const EMPTY_LANE_ITEMS: readonly Worktree[] = []
const WORKSPACE_BOARD_LANE_GAP = 12
const WORKSPACE_BOARD_LANE_OVERSCAN = 1

type WorkspaceKanbanLaneGridProps = {
  laneScrollerRef: React.RefObject<HTMLDivElement | null>
  statuses: readonly WorkspaceStatusDefinition[]
  laneViews: ReadonlyMap<WorkspaceStatus, WorkspaceKanbanLaneView>
  laneFullWorktreeIds: ReadonlyMap<WorkspaceStatus, readonly string[]>
  hasQuery: boolean
  repoMap: Map<string, Repo>
  activeWorktreeIdentity: string | null
  columnWidth: number
  isResizingColumn: boolean
  dragOverStatus: WorkspaceStatus | null
  renderCards: boolean
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onDragOver: (event: React.DragEvent, statusId: string) => void
  onDragLeave: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent, statusId: string) => void
  onActivate: () => void
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
  onCreateWorktree: (statusId: string) => void
  onColumnResizeStart: (event: React.PointerEvent<HTMLElement>) => void
  onColumnResizeKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

export default function WorkspaceKanbanLaneGrid({
  laneScrollerRef,
  statuses,
  laneViews,
  laneFullWorktreeIds,
  hasQuery,
  repoMap,
  activeWorktreeIdentity,
  columnWidth,
  isResizingColumn,
  dragOverStatus,
  renderCards,
  selectedWorktreeIds,
  selectedWorktrees,
  onDragOver,
  onDragLeave,
  onDrop,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onAssignWorkspaceStatus,
  onCreateWorktree,
  onColumnResizeStart,
  onColumnResizeKeyDown
}: WorkspaceKanbanLaneGridProps): React.JSX.Element {
  const [focusedStatusId, setFocusedStatusId] = useState<WorkspaceStatus | null>(null)
  const focusedIndex = useMemo(
    () =>
      focusedStatusId === null
        ? null
        : statuses.findIndex((status) => status.id === focusedStatusId),
    [focusedStatusId, statuses]
  )
  const estimateLaneSize = useCallback(() => columnWidth, [columnWidth])
  const getLaneKey = useCallback((index: number) => statuses[index]?.id ?? index, [statuses])
  const rangeExtractor = useCallback(
    (range: Range) => extractVirtualRangeWithFocusedIndex(range, focusedIndex),
    [focusedIndex]
  )
  const laneVirtualizer = useVirtualizer({
    count: statuses.length,
    getScrollElement: () => laneScrollerRef.current,
    estimateSize: estimateLaneSize,
    getItemKey: getLaneKey,
    horizontal: true,
    overscan: WORKSPACE_BOARD_LANE_OVERSCAN,
    gap: WORKSPACE_BOARD_LANE_GAP,
    rangeExtractor,
    useFlushSync: false
  })
  useLayoutEffect(() => {
    laneVirtualizer.measure()
  }, [columnWidth, laneVirtualizer])
  const virtualLanes = laneVirtualizer.getVirtualItems()
  const virtualStatusIds = useMemo(
    () =>
      virtualLanes.flatMap((virtualLane) => {
        const status = statuses[virtualLane.index]
        return status ? [status.id] : []
      }),
    [statuses, virtualLanes]
  )
  // Lanes hydrate their cards one per frame; the lane shells render at once.
  const renderedLaneIds = useStagedMountPerFrame(virtualStatusIds, renderCards)

  return (
    <div
      className="relative h-full min-h-0 min-w-full"
      data-contextual-tour-target="workspace-board-lanes"
      data-workspace-board-lane-grid=""
      style={{ width: `${laneVirtualizer.getTotalSize()}px` }}
      onFocusCapture={(event) => {
        const lane = (event.target as Element).closest<HTMLElement>('[data-workspace-status]')
        setFocusedStatusId(lane?.dataset.workspaceStatus ?? null)
      }}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setFocusedStatusId(null)
        }
      }}
    >
      {virtualLanes.map((virtualLane) => {
        const status = statuses[virtualLane.index]
        if (!status) {
          return null
        }
        return (
          <div
            key={virtualLane.key}
            ref={laneVirtualizer.measureElement}
            data-index={virtualLane.index}
            className="absolute left-0 top-0 h-full"
            style={{
              width: `${columnWidth}px`,
              transform: `translateX(${virtualLane.start}px)`
            }}
          >
            <WorkspaceKanbanStatusLane
              status={status}
              items={laneViews.get(status.id)?.items ?? EMPTY_LANE_ITEMS}
              totalCount={laneViews.get(status.id)?.totalCount ?? 0}
              hasQuery={hasQuery}
              fullWorktreeIds={laneFullWorktreeIds.get(status.id) ?? []}
              repoMap={repoMap}
              activeWorktreeIdentity={activeWorktreeIdentity}
              columnWidth={columnWidth}
              isResizingColumn={isResizingColumn}
              isDragTarget={dragOverStatus === status.id}
              renderCards={renderCards && renderedLaneIds.has(status.id)}
              selectedWorktreeIds={selectedWorktreeIds}
              selectedWorktrees={selectedWorktrees}
              nativeDragEnabled={false}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onActivate={onActivate}
              onSelectionGesture={onSelectionGesture}
              onContextMenuSelect={onContextMenuSelect}
              onAssignWorkspaceStatus={onAssignWorkspaceStatus}
              onCreateWorktree={onCreateWorktree}
              onColumnResizeStart={onColumnResizeStart}
              onColumnResizeKeyDown={onColumnResizeKeyDown}
            />
          </div>
        )
      })}
    </div>
  )
}
