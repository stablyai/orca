import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  measureVirtualizedListScrollMargin,
  observeVirtualizedListScrollMargin,
  VIRTUALIZED_LIST_MIN_ROWS,
  VIRTUALIZED_LIST_OVERSCAN
} from '@/components/virtualized-list'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { getWindowedCommandNavigation } from '@/lib/list-interaction/windowed-command-navigation'
import { useWindowedCommandVirtualizer } from '@/lib/list-interaction/use-windowed-command-virtualizer'
import type { PaletteListEntry } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import {
  activateWorktreeJumpPaletteEntry,
  WorktreeJumpPaletteEntry
} from './worktree-jump-palette-entry'

// Why: headings are one 11px line plus mt-3/mb-1; result rows are two lines inside py-3.
const HEADER_ESTIMATED_HEIGHT = 32
const ROW_ESTIMATED_HEIGHT = 56

export type WorktreeJumpPaletteRevealRef = React.MutableRefObject<(itemId: string) => void>

/** Movement and Enter over the full logical option list; cmdk only ever saw mounted rows. Returns true when handled. */
export function handleWorktreeJumpPaletteListKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
  controller: WorktreeJumpPaletteController,
  revealRef: WorktreeJumpPaletteRevealRef
): boolean {
  const navigation = getWindowedCommandNavigation(
    event,
    controller.selectionItemIds,
    controller.commandSelectedItemId,
    { loop: true }
  )
  if (navigation) {
    event.preventDefault()
    if (navigation.targetId !== null) {
      controller.selectionMovedByUserRef.current = true
      controller.setSelectedItemId(navigation.targetId)
      revealRef.current(navigation.targetId)
    }
    return true
  }
  if (event.key !== 'Enter' || isImeOwnedKeyboardEvent(event)) {
    return false
  }
  const index = controller.listEntryRenderKeys.indexOf(controller.commandSelectedItemId)
  const entry = controller.listEntries[index]
  if (!entry) {
    return false
  }
  event.preventDefault()
  activateWorktreeJumpPaletteEntry(entry, controller.commandSelectedItemId, controller)
  return true
}

function estimateEntryHeight(entry: PaletteListEntry | undefined): number {
  return entry?.type === 'section-header' ? HEADER_ESTIMATED_HEIGHT : ROW_ESTIMATED_HEIGHT
}

export function WorktreeJumpPaletteResultList({
  controller,
  scrollElement,
  revealRef
}: {
  controller: WorktreeJumpPaletteController
  // State, not a ref: the virtualizer must re-attach when the dialog mounts its scroller.
  scrollElement: HTMLDivElement | null
  revealRef: WorktreeJumpPaletteRevealRef
}): React.JSX.Element {
  const { listEntries, listEntryRenderKeys, commandSelectedItemId } = controller
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  // Small result sets keep natural layout; the empty-query palette stays well under this.
  const windowed = listEntries.length >= VIRTUALIZED_LIST_MIN_ROWS
  const entryIndexByKey = useMemo(
    () => new Map(listEntryRenderKeys.map((key, index) => [key, index])),
    [listEntryRenderKeys]
  )
  const activeIndex = entryIndexByKey.get(commandSelectedItemId) ?? -1

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!windowed || !container || !scrollElement) {
      return
    }
    const updateMargin = (): void => {
      const nextMargin = measureVirtualizedListScrollMargin(container, scrollElement)
      setScrollMargin((current) => (current === nextMargin ? current : nextMargin))
    }
    updateMargin()
    return observeVirtualizedListScrollMargin(container, scrollElement, updateMargin)
  }, [scrollElement, windowed])

  // Estimates are read lazily per row; a header and an option never share a key.
  const estimateSize = useCallback(
    (index: number) => estimateEntryHeight(listEntries[index]),
    [listEntries]
  )
  const virtualizer = useWindowedCommandVirtualizer({
    itemKeys: listEntryRenderKeys,
    enabled: windowed && scrollElement !== null,
    scrollElement: () => scrollElement,
    estimateSize,
    activeIndex,
    overscan: VIRTUALIZED_LIST_OVERSCAN,
    scrollMargin,
    // Crossing the threshold (See more) attaches mid-scroll; keep the current position.
    initialOffset: () => scrollElement?.scrollTop ?? 0
  })

  const { getOptionId } = controller
  useLayoutEffect(() => {
    revealRef.current = (itemId: string): void => {
      const index = entryIndexByKey.get(itemId)
      if (index === undefined) {
        return
      }
      if (windowed) {
        virtualizer.scrollToIndex(index, { align: 'auto' })
        return
      }
      const optionId = getOptionId(itemId)
      const option = optionId ? document.getElementById(optionId) : null
      option?.scrollIntoView({ block: 'nearest' })
    }
  }, [entryIndexByKey, getOptionId, revealRef, virtualizer, windowed])

  if (!windowed) {
    return (
      <>
        {listEntries.map((entry, index) => (
          <WorktreeJumpPaletteEntry
            key={listEntryRenderKeys[index] ?? entry.id}
            entry={entry}
            renderKey={listEntryRenderKeys[index] ?? entry.id}
            controller={controller}
          />
        ))}
      </>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const entry = listEntries[item.index]
        if (!entry) {
          return null
        }
        const renderKey = listEntryRenderKeys[item.index] ?? entry.id
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute top-0 left-0 w-full"
            // Item positions include the scroller-wide margin; subtract it for container-relative placement.
            style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
          >
            <WorktreeJumpPaletteEntry entry={entry} renderKey={renderKey} controller={controller} />
          </div>
        )
      })}
    </div>
  )
}
