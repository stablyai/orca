import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type Range } from '@tanstack/react-virtual'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { extractPinnedVirtualRange } from '@/lib/list-interaction/pinned-virtual-range'
import { AgentKanbanCard } from './AgentKanbanCard'
import {
  focusAgentKanbanCardEdge,
  resolveAgentKanbanTabBridge,
  type AgentKanbanCardEdge
} from './agent-kanban-lane-tab-bridge'

// Estimates follow the card's fixed rows; measurement replaces them for message/question variants.
const AGENT_CARD_ESTIMATED_HEIGHT = 104
const AGENT_CARD_SUBAGENT_TOGGLE_HEIGHT = 22
const AGENT_CARD_SUBAGENT_ROW_HEIGHT = 25
const AGENT_CARD_GAP = 8
const AGENT_CARD_OVERSCAN = 6
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
  const indexByPaneKey = useMemo(
    () => new Map(cards.map((card, index) => [card.paneKey, index])),
    [cards]
  )
  const [expandedPaneKeys, setExpandedPaneKeys] = useState<ReadonlySet<string>>(EMPTY_PANE_KEYS)
  // Last focused card stays pinned after focus leaves the lane so dialog close and window refocus can return to it.
  const [focusedPaneKey, setFocusedPaneKey] = useState<string | null>(null)
  const [pendingTab, setPendingTab] = useState<PendingTabTarget | null>(null)

  // Leaving the lane resets disclosure, matching the unmount that bucket moves and filtering caused before windowing.
  useEffect(() => {
    setExpandedPaneKeys((current) => {
      const retained = [...current].filter((paneKey) => indexByPaneKey.has(paneKey))
      return retained.length === current.size ? current : new Set(retained)
    })
    setFocusedPaneKey((current) =>
      current !== null && !indexByPaneKey.has(current) ? null : current
    )
  }, [indexByPaneKey])

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
  // Lane endpoints stay mounted so native Tab enters and leaves the lane at its logical first and last cards.
  const rangeExtractor = useCallback(
    (range: Range) =>
      extractPinnedVirtualRange(range, [
        0,
        range.count - 1,
        focusedIndex,
        dialogIndex,
        pendingIndex
      ]),
    [dialogIndex, focusedIndex, pendingIndex]
  )
  const estimateSize = useCallback(
    (index: number) => {
      const subagentCount = cards[index]?.subagents?.length ?? 0
      if (subagentCount === 0) {
        return AGENT_CARD_ESTIMATED_HEIGHT
      }
      const expanded = expandedPaneKeys.has(cards[index].paneKey)
      return (
        AGENT_CARD_ESTIMATED_HEIGHT +
        AGENT_CARD_SUBAGENT_TOGGLE_HEIGHT +
        (expanded ? subagentCount * AGENT_CARD_SUBAGENT_ROW_HEIGHT : 0)
      )
    },
    [cards, expandedPaneKeys]
  )
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scrollElement,
    estimateSize,
    getItemKey: useCallback((index: number) => cards[index]?.paneKey ?? index, [cards]),
    overscan: AGENT_CARD_OVERSCAN,
    gap: AGENT_CARD_GAP,
    rangeExtractor,
    // Async renders plus overscan avoid blocking wheel events with rich-card flushes.
    useFlushSync: false
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
    virtualizer.scrollToIndex(index, { align: 'auto' })
    focusAgentKanbanCardEdge(row, pendingTab.edge)
  }, [indexByPaneKey, pendingTab, virtualizer])

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
      style={{ height: `${virtualizer.getTotalSize()}px` }}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const card = cards[virtualItem.index]
        if (!card) {
          return null
        }
        return (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
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
