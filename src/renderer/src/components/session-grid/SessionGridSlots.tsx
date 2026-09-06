import React from 'react'
import { SortableSessionGridCard } from './SortableSessionGridCard'
import { SessionGridEmptySlot } from './SessionGridEmptySlot'
import type { SessionGridWorktreeCatalog } from './session-grid-worktree-catalog'
import type { SessionGridFilter, SessionGridItem } from '../../../../shared/session-grid-types'

export type SessionGridCardActions = {
  onFocus: (tabId: string) => void
  onMaximize: (item: SessionGridItem) => void
  onClose: (tabId: string) => void
  onToggleHidden: (tabId: string) => void
}

/** What both scroll layouts take from the page. */
export type SessionGridLayoutProps = {
  items: SessionGridItem[]
  totalSlotCount: number
  cols: number
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  setScrollContainer: (element: HTMLDivElement | null) => void
  onScroll: () => void
  activeSessionGridTabId: string | null
  activeFilter: SessionGridFilter
  defaultWorktreeId: string | undefined
  worktreeCatalog: SessionGridWorktreeCatalog
  /** Workspaces with a card on the grid, in grid order; what the launcher leads with. */
  gridWorktreeIds: readonly string[]
  actions: SessionGridCardActions
}

/** The cards of one row or page, then its vacant slots. */
export function SessionGridSlots({
  items,
  emptySlotCount,
  emptySlotKeyPrefix,
  renderedTabIds,
  activeSessionGridTabId,
  activeFilter,
  defaultWorktreeId,
  worktreeCatalog,
  gridWorktreeIds,
  actions
}: Pick<
  SessionGridLayoutProps,
  | 'activeSessionGridTabId'
  | 'activeFilter'
  | 'defaultWorktreeId'
  | 'worktreeCatalog'
  | 'gridWorktreeIds'
  | 'actions'
> & {
  items: SessionGridItem[]
  emptySlotCount: number
  emptySlotKeyPrefix: string
  /** Tabs whose terminal may mount now; the rest render as shells. */
  renderedTabIds: ReadonlySet<string>
}): React.JSX.Element {
  return (
    <>
      {items.map((item) => (
        <div key={item.tabId} className="h-full min-h-0 min-w-0">
          <SortableSessionGridCard
            item={item}
            isActive={activeSessionGridTabId === item.tabId}
            previewMounted={renderedTabIds.has(item.tabId)}
            actions={actions}
          />
        </div>
      ))}
      {Array.from({ length: emptySlotCount }).map((_, slotIdx) => (
        <div key={`${emptySlotKeyPrefix}-${slotIdx}`} className="h-full min-h-0 min-w-0">
          <SessionGridEmptySlot
            activeFilter={activeFilter}
            defaultWorktreeId={defaultWorktreeId}
            worktreeCatalog={worktreeCatalog}
            gridWorktreeIds={gridWorktreeIds}
          />
        </div>
      ))}
    </>
  )
}
