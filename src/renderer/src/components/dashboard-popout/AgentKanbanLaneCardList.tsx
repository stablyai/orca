import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { AgentKanbanCard } from './AgentKanbanCard'
import {
  focusAgentKanbanCardEdge,
  resolveAgentKanbanTabBridge,
  type AgentKanbanCardEdge
} from './agent-kanban-lane-tab-bridge'
import { useAgentKanbanLaneVirtualizer } from './use-agent-kanban-lane-virtualizer'

const EMPTY_PANE_KEYS: ReadonlySet<string> = new Set()

type PendingTabTarget = { paneKey: string; edge: AgentKanbanCardEdge; origin: EventTarget }

type AgentKanbanLaneCardListProps = {
  cards: DashboardCard[]
  scrollElement: HTMLDivElement | null
  repoIconsByRepoId: Record<string, RepoIcon | null> | undefined
  now: number
  /** Keep the dialog opener mounted so in-lane reorders cannot detach Radix's focus-return node. */
  dialogPaneKey: string | null
  onOpenTerminal: (card: DashboardCard) => void
}

function laneRow(target: EventTarget): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-pane-key]') : null
}

/** Window one lane's cards in its existing scroller while keeping lane order, disclosure and Tab order logical. */
export const AgentKanbanLaneCardList = memo(function AgentKanbanLaneCardList({
  cards,
  scrollElement,
  repoIconsByRepoId,
  now,
  dialogPaneKey,
  onOpenTerminal
}: AgentKanbanLaneCardListProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [previousPaneKeys, setPreviousPaneKeys] = useState(() => cards.map((card) => card.paneKey))
  const paneKeys = useMemo(
    () =>
      cards.length === previousPaneKeys.length &&
      cards.every((card, index) => card.paneKey === previousPaneKeys[index])
        ? previousPaneKeys
        : cards.map((card) => card.paneKey),
    [cards, previousPaneKeys]
  )
  if (paneKeys !== previousPaneKeys) {
    setPreviousPaneKeys(paneKeys)
  }
  const indexByPaneKey = useMemo(
    () => new Map(paneKeys.map((paneKey, index) => [paneKey, index])),
    [paneKeys]
  )
  const [expandedPaneKeys, setExpandedPaneKeys] = useState<ReadonlySet<string>>(EMPTY_PANE_KEYS)
  // Last focused card stays pinned after focus leaves the lane so dialog close and window refocus can return to it.
  const [focusedPaneKey, setFocusedPaneKey] = useState<string | null>(null)
  const [pendingTab, setPendingTab] = useState<PendingTabTarget | null>(null)

  // Leaving the lane resets disclosure, matching the unmount that bucket moves and filtering caused before windowing.
  const [prunedFor, setPrunedFor] = useState(indexByPaneKey)
  if (prunedFor !== indexByPaneKey) {
    setPrunedFor(indexByPaneKey)
    const retained = [...expandedPaneKeys].filter((paneKey) => indexByPaneKey.has(paneKey))
    if (retained.length !== expandedPaneKeys.size) {
      setExpandedPaneKeys(new Set(retained))
    }
    if (focusedPaneKey !== null && !indexByPaneKey.has(focusedPaneKey)) {
      setFocusedPaneKey(null)
    }
  }

  const toggleSubagents = useCallback((paneKey: string) => {
    setExpandedPaneKeys((current) => {
      const next = new Set(current)
      if (!next.delete(paneKey)) {
        next.add(paneKey)
      }
      return next
    })
  }, [])

  const focusedIndex = focusedPaneKey === null ? undefined : indexByPaneKey.get(focusedPaneKey)
  const dialogIndex = dialogPaneKey === null ? undefined : indexByPaneKey.get(dialogPaneKey)
  const pendingIndex = pendingTab ? indexByPaneKey.get(pendingTab.paneKey) : undefined
  const { virtualItems, totalSize, measureElement, scrollToIndex } = useAgentKanbanLaneVirtualizer({
    cards,
    paneKeys,
    indexByPaneKey,
    scrollElement,
    expandedPaneKeys,
    focusedIndex,
    dialogIndex,
    pendingIndex
  })

  // Settle a bridged Tab on the commit that mounts its target; anything stale cancels instead of retrying.
  useLayoutEffect(() => {
    if (!pendingTab) {
      return
    }
    setPendingTab(null)
    const index = indexByPaneKey.get(pendingTab.paneKey)
    if (index === undefined) {
      return
    }
    const row = listRef.current?.querySelector(`:scope > [data-index="${index}"]`)
    if (!row || row.ownerDocument.activeElement !== pendingTab.origin) {
      return
    }
    scrollToIndex(index, { align: pendingTab.edge === 'first' ? 'start' : 'end' })
    focusAgentKanbanCardEdge(row, pendingTab.edge)
  }, [indexByPaneKey, pendingTab, scrollToIndex])

  const handleFocus = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const paneKey = laneRow(event.target)?.dataset.paneKey
    if (paneKey !== undefined) {
      setFocusedPaneKey(paneKey)
    }
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        event.key !== 'Tab' ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return
      }
      const row = laneRow(event.target)
      const paneKey = row?.dataset.paneKey
      const index = paneKey === undefined ? undefined : indexByPaneKey.get(paneKey)
      if (!row || index === undefined) {
        return
      }
      const bridge = resolveAgentKanbanTabBridge(
        row,
        event.target,
        event.shiftKey,
        index,
        cards.length
      )
      if (!bridge) {
        return
      }
      event.preventDefault()
      setPendingTab({
        paneKey: cards[bridge.index].paneKey,
        edge: bridge.edge,
        origin: event.target
      })
    },
    [cards, indexByPaneKey]
  )

  return (
    <div
      ref={listRef}
      role="list"
      className="relative w-full"
      style={{ height: `${totalSize}px` }}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
    >
      {virtualItems.map((virtualItem) => {
        const card = cards[virtualItem.index]
        if (!card) {
          return null
        }
        return (
          <div
            key={virtualItem.key}
            ref={measureElement}
            data-index={virtualItem.index}
            data-pane-key={card.paneKey}
            role="listitem"
            // Announce the full logical lane, not the mounted window.
            aria-setsize={cards.length}
            aria-posinset={virtualItem.index + 1}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            <AgentKanbanCard
              card={card}
              repoIcon={repoIconsByRepoId?.[card.repoId] ?? null}
              now={now}
              subagentsOpen={expandedPaneKeys.has(card.paneKey)}
              onToggleSubagents={toggleSubagents}
              onOpenTerminal={onOpenTerminal}
            />
          </div>
        )
      })}
    </div>
  )
})
