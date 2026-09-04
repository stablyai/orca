import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { useAppStore } from '@/store'
import { buildSessionGridDragOrder } from '@/store/slices/session-grid-tab-order'
import { TooltipProvider } from '@/components/ui/tooltip'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { useSessionsGridItems } from './use-sessions-grid-items'
import { maximizeSessionGridCard } from './session-grid-card-maximize'
import { SessionGridOffscreenAttentionPill } from './SessionGridOffscreenAttentionPill'
import { resolveSessionGridOffscreenAttention } from './session-grid-offscreen-attention'
import { sessionGridDirectLaunchTarget } from './SessionGridLaunchPicker'
import { SessionGridEmptyState } from './SessionGridEmptyState'
import { resolveSessionGridEmptyStateReason } from './session-grid-empty-state'
import { useSessionGridScroll } from './use-session-grid-scroll'
import { useSessionGridKeyboardNavigation } from './use-session-grid-keyboard-navigation'
import { computeGridDimensions, computeSessionGridSlotCounts } from './session-grid-slot-layout'
import { SessionGridToolbar } from './SessionGridToolbar'
import { SessionGridCardOverlay } from './SessionGridCardOverlay'
import type { SessionGridCardActions, SessionGridLayoutProps } from './SessionGridSlots'
import { SessionGridRowScrollLayout } from './SessionGridRowScrollLayout'
import { SessionGridPageScrollLayout } from './SessionGridPageScrollLayout'

// Pointer must travel this far before a drag starts, so a click still focuses the card.
const DRAG_ACTIVATION_DISTANCE_PX = 8
// The expand/collapse easing from main.css: the card settles, it does not bounce.
const DROP_ANIMATION = { duration: 150, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }

export default function SessionsGridPage(): React.JSX.Element {
  // Why local and not persisted: revealing is a momentary management mode, and losing
  // it on the way out of the view is the point.
  const [revealHidden, setRevealHidden] = useState(false)
  const {
    items,
    allItems,
    filterOptions,
    activeFilter,
    stateCounts,
    activeStateFilter,
    hiddenCount,
    worktreeCatalog
  } = useSessionsGridItems({ revealHidden })
  const sessionsGridPreset = useAppStore((s) => s.sessionsGridPreset)
  const sessionsGridShowEmpty = useAppStore((s) => s.sessionsGridShowEmpty)
  const sessionsGridScrollMode = useAppStore((s) => s.sessionsGridScrollMode)
  const sessionsGridWheelTarget = useAppStore((s) => s.sessionsGridWheelTarget)
  const activeSessionGridTabId = useAppStore((s) => s.activeSessionGridTabId)
  const setActiveSessionGridTabId = useAppStore((s) => s.setActiveSessionGridTabId)
  const closeSessionsPage = useAppStore((s) => s.closeSessionsPage)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setSessionsGridTabOrder = useAppStore((s) => s.setSessionsGridTabOrder)
  // Read once here, not once per card: the per-card listener budget is pinned by test.
  const toggleSessionsGridHiddenTab = useAppStore((s) => s.toggleSessionsGridHiddenTab)

  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const toggleReveal = useCallback(() => setRevealHidden((on) => !on), [])
  const setSessionsGridFilter = useAppStore((s) => s.setSessionsGridFilter)
  const setSessionsGridStateFilter = useAppStore((s) => s.setSessionsGridStateFilter)
  // Both axes the empty state can blame, cleared together: offering to clear "filters" and
  // leaving one of them armed is the same dead end this screen exists to remove.
  const clearFilters = useCallback(() => {
    setSessionsGridFilter('all')
    setSessionsGridStateFilter('all')
  }, [setSessionsGridFilter, setSessionsGridStateFilter])
  // Why the mode cannot outlive its subject: the view menu's checkbox goes disabled at zero,
  // so showing the last hidden card again would leave the mode stuck on with no live switch
  // — and the next Hide would leave that card dimmed in place, reading as a broken button.
  // Nothing flickers: revealing nothing is the same view as not revealing.
  useEffect(() => {
    if (hiddenCount === 0) {
      setRevealHidden(false)
    }
  }, [hiddenCount])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX } })
  )

  const { cols, rowsPerView } = useMemo(
    () => computeGridDimensions(sessionsGridPreset, items.length),
    [sessionsGridPreset, items.length]
  )
  const { totalSlotCount, totalRowCount, totalPageCount } = computeSessionGridSlotCounts({
    itemCount: items.length,
    cols,
    rowsPerView,
    showEmpty: sessionsGridShowEmpty
  })

  const scroll = useSessionGridScroll({
    mode: sessionsGridScrollMode,
    wheelTarget: sessionsGridWheelTarget,
    rowsPerView,
    totalRowCount,
    totalPageCount
  })
  useSessionGridKeyboardNavigation({
    currentPositionRef: scroll.currentPositionRef,
    scrollToPosition: scroll.scrollToPosition
  })

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
  }, [])
  const handleDragCancel = useCallback(() => setActiveDragId(null), [])
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveDragId(null)
      if (!over || active.id === over.id) {
        return
      }
      // Why the global list: under a workspace filter `items` is a subset, and
      // saving a subset as the whole order pushed every other card to the end.
      // The grid order is its own cross-workspace ordering — it does not touch
      // tabsByWorktree, whose sortOrder drives the sidebar and paired clients.
      const newOrder = buildSessionGridDragOrder(
        allItems.map((i) => i.tabId),
        String(active.id),
        String(over.id)
      )
      if (newOrder) {
        setSessionsGridTabOrder(newOrder)
      }
    },
    [allItems, setSessionsGridTabOrder]
  )
  const activeDragItem = useMemo(
    () => (activeDragId ? items.find((i) => i.tabId === activeDragId) : null),
    [activeDragId, items]
  )
  // The builder keeps `items` stable across a status burst; mapping it inline would
  // hand the sortable context a new array anyway.
  const sortableIds = useMemo(() => items.map((i) => i.tabId), [items])

  const cardActions = useMemo<SessionGridCardActions>(
    () => ({
      onFocus: setActiveSessionGridTabId,
      onMaximize: maximizeSessionGridCard,
      onClose: closeTerminalTab,
      onToggleHidden: toggleSessionsGridHiddenTab
    }),
    [setActiveSessionGridTabId, toggleSessionsGridHiddenTab]
  )

  // Why a menu and not a click handler: opened from Landing there is no active
  // workspace to launch into, and a bare button would have nothing to do. The
  // entry count, not the group count: a repo group can hold no workspace at all.
  const canLaunchFirst =
    sessionGridDirectLaunchTarget(activeFilter, activeWorktreeId ?? undefined) !== null ||
    worktreeCatalog.byWorktreeId.size > 0

  // Pure arithmetic over what the scroll hook already publishes: no observer, no measuring,
  // and the target card does not need to be mounted — the pill only needs its index.
  const offscreenAttention = useMemo(
    () =>
      resolveSessionGridOffscreenAttention({
        items,
        cols,
        rowsPerView,
        mode: sessionsGridScrollMode,
        firstVisibleRow: scroll.firstVisibleRow
      }),
    [items, cols, rowsPerView, sessionsGridScrollMode, scroll.firstVisibleRow]
  )
  const scrollToPosition = scroll.scrollToPosition
  const jumpAbove = useCallback(
    () => scrollToPosition(offscreenAttention.above?.targetPosition ?? 0),
    [scrollToPosition, offscreenAttention.above]
  )
  const jumpBelow = useCallback(
    () => scrollToPosition(offscreenAttention.below?.targetPosition ?? 0),
    [scrollToPosition, offscreenAttention.below]
  )

  // The workspaces with a card on the grid, which the launcher leads with.
  const gridWorktreeIds = useMemo(
    () => filterOptions.filter((option) => option.id !== 'all').map((option) => option.id),
    [filterOptions]
  )

  const layoutProps: SessionGridLayoutProps = {
    items,
    totalSlotCount,
    cols,
    scrollContainerRef: scroll.scrollContainerRef,
    setScrollContainer: scroll.setScrollContainer,
    onScroll: scroll.handleScroll,
    activeSessionGridTabId,
    activeFilter,
    defaultWorktreeId: activeWorktreeId ?? undefined,
    worktreeCatalog,
    gridWorktreeIds,
    actions: cardActions
  }

  return (
    // Its own provider only so the page renders standalone; the same 400 ms as the app root
    // and the sidebar, so a pointer crossing from one to the other feels no seam.
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden bg-background">
        <SessionGridToolbar
          filterOptions={filterOptions}
          activeFilter={activeFilter}
          stateCounts={stateCounts}
          activeStateFilter={activeStateFilter}
          hiddenCount={hiddenCount}
          revealHidden={revealHidden}
          onToggleReveal={toggleReveal}
          worktreeCatalog={worktreeCatalog}
          {...(activeWorktreeId ? { defaultWorktreeId: activeWorktreeId } : {})}
          currentPage={scroll.currentPosition}
          totalPages={scroll.maxPosition + 1}
          onPageChange={scroll.scrollToPosition}
          onBack={closeSessionsPage}
        />

        {items.length === 0 ? (
          <SessionGridEmptyState
            reason={resolveSessionGridEmptyStateReason({
              allItemCount: allItems.length,
              stateCounts,
              hiddenCount,
              activeFilter
            })}
            canLaunchFirst={canLaunchFirst}
            activeFilter={activeFilter}
            {...(activeWorktreeId ? { defaultWorktreeId: activeWorktreeId } : {})}
            worktreeCatalog={worktreeCatalog}
            gridWorktreeIds={gridWorktreeIds}
            onRevealHidden={toggleReveal}
            onClearFilters={clearFilters}
          />
        ) : (
          // Why its own relative box and not the page root: the pills are positioned against
          // the scrolling area, and an `above` pill anchored to the root would land on the toolbar.
          <div className="relative flex flex-1 min-h-0 flex-col">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
                {sessionsGridScrollMode === 'page' ? (
                  <SessionGridPageScrollLayout
                    {...layoutProps}
                    rowsPerView={rowsPerView}
                    currentPage={scroll.currentPosition}
                  />
                ) : (
                  <SessionGridRowScrollLayout
                    {...layoutProps}
                    rowHeight={scroll.rowHeight}
                    isFreeMode={sessionsGridScrollMode === 'free'}
                  />
                )}
              </SortableContext>
              <DragOverlay dropAnimation={DROP_ANIMATION}>
                {activeDragItem ? (
                  <div className="h-full w-full" style={{ height: `${scroll.rowHeight}px` }}>
                    <SessionGridCardOverlay item={activeDragItem} />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
            {offscreenAttention.above && (
              <SessionGridOffscreenAttentionPill
                direction="above"
                count={offscreenAttention.above.count}
                onClick={jumpAbove}
              />
            )}
            {offscreenAttention.below && (
              <SessionGridOffscreenAttentionPill
                direction="below"
                count={offscreenAttention.below.count}
                onClick={jumpBelow}
              />
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
