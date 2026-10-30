import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatus, Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import WorkspaceKanbanCard from './WorkspaceKanbanCard'
import { registerWorkspaceKanbanVirtualLaneLayout } from './workspace-kanban-virtual-lane-layout'

// Estimate uniform card height so the first virtual window cannot reflow after measurement.
const WORKSPACE_BOARD_CARD_ESTIMATED_HEIGHT = 36
const WORKSPACE_BOARD_CARD_GAP = 8
const WORKSPACE_BOARD_CARD_OVERSCAN = 6

function estimateWorkspaceBoardCardSize(): number {
  return WORKSPACE_BOARD_CARD_ESTIMATED_HEIGHT
}

type WorkspaceKanbanLaneCardListProps = {
  items: readonly Worktree[]
  repoMap: Map<string, Repo>
  activeWorktreeIdentity: string | null
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
  activeWorktreeIdentity,
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
  const itemIds = useMemo(() => items.map(getWorktreeHostIdentity), [items])
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateWorkspaceBoardCardSize,
    getItemKey: useCallback(
      (index: number) => (items[index] ? getWorktreeHostIdentity(items[index]) : index),
      [items]
    ),
    overscan: WORKSPACE_BOARD_CARD_OVERSCAN,
    gap: WORKSPACE_BOARD_CARD_GAP,
    // Async renders plus overscan avoid blocking wheel events with rich-card flushes.
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
      getWorktreeIds: () => items.map((item) => item.id),
      getMeasurements: () => virtualizer.measurementsCache
    })
  }, [itemIds, items, scrollRef, virtualizer])

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
        const worktreeIdentity = getWorktreeHostIdentity(worktree)
        const isSelected = selectedWorktreeIds.has(worktreeIdentity)
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
              isActive={activeWorktreeIdentity === worktreeIdentity}
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
