import React, {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useVirtualizer, type Range } from '@tanstack/react-virtual'
import type {
  Repo,
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/types'
import type { WorkspaceKanbanLaneView } from './workspace-kanban-search'
import { extractWorkspaceKanbanLaneRange } from './workspace-kanban-lane-range'
import WorkspaceKanbanStatusLane from './WorkspaceKanbanStatusLane'

// Why: a fresh [] per render would defeat the memoized lane on empty lanes.
const EMPTY_LANE_ITEMS: readonly Worktree[] = []
const EMPTY_RENDERED_LANE_IDS: ReadonlySet<WorkspaceStatus> = new Set()
const WORKSPACE_BOARD_LANE_GAP = 12
const WORKSPACE_BOARD_LANE_OVERSCAN = 1

type WorkspaceKanbanLaneGridProps = {
  laneScrollerRef: React.RefObject<HTMLDivElement | null>
  statuses: readonly WorkspaceStatusDefinition[]
  laneViews: ReadonlyMap<WorkspaceStatus, WorkspaceKanbanLaneView>
  laneFullWorktreeIds: ReadonlyMap<WorkspaceStatus, readonly string[]>
  hasQuery: boolean
  repoMap: Map<string, Repo>
  activeWorktreeId: string | null
  columnWidth: number
  isResizingColumn: boolean
  dragOverStatus: WorkspaceStatus | null
  canCreateWorktree: boolean
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
  activeWorktreeId,
  columnWidth,
  isResizingColumn,
  dragOverStatus,
  canCreateWorktree,
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
  const [renderedLaneIds, setRenderedLaneIds] =
    useState<ReadonlySet<WorkspaceStatus>>(EMPTY_RENDERED_LANE_IDS)
  const renderedLaneIdsRef = useRef(renderedLaneIds)
  const renderCardsRef = useRef(renderCards)
  useLayoutEffect(() => {
    renderedLaneIdsRef.current = renderedLaneIds
    renderCardsRef.current = renderCards
  }, [renderCards, renderedLaneIds])
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
    (range: Range) => extractWorkspaceKanbanLaneRange(range, focusedIndex),
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
  const mountedLaneIds = useMemo(() => new Set(virtualStatusIds), [virtualStatusIds])
  const mountedLaneIdsRef = useRef<ReadonlySet<WorkspaceStatus>>(mountedLaneIds)
  useLayoutEffect(() => {
    mountedLaneIdsRef.current = mountedLaneIds
  }, [mountedLaneIds])
  useEffect(() => {
    if (!renderCards) {
      setRenderedLaneIds(EMPTY_RENDERED_LANE_IDS)
      return
    }
    const missingIds = virtualStatusIds.filter((id) => !renderedLaneIdsRef.current.has(id))
    setRenderedLaneIds((current) => {
      const retained = new Set(Array.from(current).filter((id) => mountedLaneIds.has(id)))
      return retained.size === current.size ? current : retained
    })
    let nextIndex = 0
    let frameId = 0
    const renderNextLane = (): void => {
      const statusId = missingIds[nextIndex]
      nextIndex += 1
      if (!statusId) {
        return
      }
      startTransition(() => {
        setRenderedLaneIds((current) => {
          if (!renderCardsRef.current || !mountedLaneIdsRef.current.has(statusId)) {
            return current
          }
          return new Set(current).add(statusId)
        })
      })
      if (nextIndex < missingIds.length) {
        frameId = window.requestAnimationFrame(renderNextLane)
      }
    }
    if (missingIds.length > 0) {
      frameId = window.requestAnimationFrame(renderNextLane)
    }
    return () => window.cancelAnimationFrame(frameId)
  }, [mountedLaneIds, renderCards, virtualStatusIds])

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
              activeWorktreeId={activeWorktreeId}
              columnWidth={columnWidth}
              isResizingColumn={isResizingColumn}
              isDragTarget={dragOverStatus === status.id}
              canCreateWorktree={canCreateWorktree}
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
