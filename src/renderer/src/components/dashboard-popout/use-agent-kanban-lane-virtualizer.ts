import { useCallback } from 'react'
import { useVirtualizer, type Range } from '@tanstack/react-virtual'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { extractPinnedVirtualRange } from '@/lib/list-interaction/pinned-virtual-range'

// Estimates follow the card's fixed rows; measurement replaces them for message/question variants.
const AGENT_CARD_ESTIMATED_HEIGHT = 104
const AGENT_CARD_SUBAGENT_TOGGLE_HEIGHT = 22
const AGENT_CARD_SUBAGENT_ROW_HEIGHT = 25
const AGENT_CARD_GAP = 8
const AGENT_CARD_OVERSCAN = 6

/**
 * Own the lane virtualizer apart from the card list so the list stays compiler-memoized.
 * Returns fresh window values each render; the virtualizer instance itself never changes identity.
 */
export function useAgentKanbanLaneVirtualizer({
  cards,
  scrollElement,
  expandedPaneKeys,
  focusedIndex,
  dialogIndex,
  pendingIndex
}: {
  cards: DashboardCard[]
  scrollElement: HTMLDivElement | null
  expandedPaneKeys: ReadonlySet<string>
  focusedIndex: number | undefined
  dialogIndex: number | undefined
  pendingIndex: number | undefined
}) {
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
  return {
    virtualItems: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    measureElement: virtualizer.measureElement,
    scrollToIndex: virtualizer.scrollToIndex
  }
}
