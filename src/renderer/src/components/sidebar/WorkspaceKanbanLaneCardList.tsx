import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Repo, WorkspaceStatus, Worktree } from '../../../../shared/types'
import WorkspaceKanbanCard from './WorkspaceKanbanCard'
import { registerWorkspaceKanbanVirtualLaneLayout } from './workspace-kanban-virtual-lane-layout'

// Why: board cards are uniform one-line rows; a close estimate keeps the first
// virtual window right so the lane does not reflow once cards measure.
const WORKSPACE_BOARD_CARD_ESTIMATED_HEIGHT = 36
// Matches the `space-y-2` rhythm the lane used before virtualization.
const WORKSPACE_BOARD_CARD_GAP = 8
const WORKSPACE_BOARD_CARD_OVERSCAN = 6

function estimateWorkspaceBoardCardSize(): number {
  return WORKSPACE_BOARD_CARD_ESTIMATED_HEIGHT
}

type WorkspaceKanbanLaneCardListProps = {
  items: readonly Worktree[]
  repoMap: Map<string, Repo>
  activeWorktreeId: string | null
  scrollRef: React.RefObject<HTMLDivElement | null>
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  nativeDragEnabled: boolean
  onActivate: () => void
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
}

function WorkspaceKanbanLaneCardList({
  items,
  repoMap,
  activeWorktreeId,
  scrollRef,
  selectedWorktreeIds,
  selectedWorktrees,
  nativeDragEnabled,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onAssignWorkspaceStatus
}: WorkspaceKanbanLaneCardListProps): React.JSX.Element {
  const spacerRef = useRef<HTMLDivElement | null>(null)
  const itemIds = useMemo(() => items.map((item) => item.id), [items])
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateWorkspaceBoardCardSize,
    getItemKey: useCallback((index: number) => items[index]?.id ?? index, [items]),
    overscan: WORKSPACE_BOARD_CARD_OVERSCAN,
    gap: WORKSPACE_BOARD_CARD_GAP,
    // Why: sync-flushing rich card renders inside the scroll listener stalls the
    // wheel; async + overscan keeps the lane filled without blocking input.
    useFlushSync: false
  })

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    const spacerElement = spacerRef.current
    if (!scrollElement || !spacerElement) {
      return
    }
    return registerWorkspaceKanbanVirtualLaneLayout({
      scrollElement,
      spacerElement,
      getItemIds: () => itemIds,
      getMeasurements: () => virtualizer.measurementsCache
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- virtualizer is a stable instance (useVirtualizer holds it in useState), and getMeasurements reads measurementsCache off it live.
  }, [itemIds, scrollRef])

  return (
    <div
      ref={spacerRef}
      className="relative w-full"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const worktree = items[virtualItem.index]
        if (!worktree) {
          return null
        }
        const isSelected = selectedWorktreeIds.has(worktree.id)
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            <WorkspaceKanbanCard
              worktree={worktree}
              laneIndex={virtualItem.index}
              repo={repoMap.get(worktree.repoId)}
              isActive={activeWorktreeId === worktree.id}
              isSelected={isSelected}
              nativeDragEnabled={nativeDragEnabled}
              selectedWorktrees={
                isSelected && selectedWorktrees.length > 0 ? selectedWorktrees : undefined
              }
              onActivate={onActivate}
              onSelectionGesture={onSelectionGesture}
              onContextMenuSelect={onContextMenuSelect}
              onAssignWorkspaceStatus={onAssignWorkspaceStatus}
            />
          </div>
        )
      })}
    </div>
  )
}

export default React.memo(WorkspaceKanbanLaneCardList)
