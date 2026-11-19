import { useEffect, useMemo, useState } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { matchKeybindingDigitIndex } from '../../../../../shared/keybindings/matching'
import { getKeybindingContext } from '../../terminal/workbench/terminal-workspace-model'
import type { ActivityVirtualItemDescriptor } from './activity-thread-virtual-items'
import type { AgentPaneThread } from '../threads/activity-thread-types'

export const ACTIVITY_INDEX_ACTION_ID = 'activity.selectByIndex'
const MAX_INDEX_HINTS = 9

/** True while exactly the select-by-index chord's modifiers are down, so the 1-9 badges can show. */
function isActivityIndexChordHeld(event: KeyboardEvent): boolean {
  // Probe with a digit: the matcher owns Mod/platform resolution and remapped chords.
  const probe = {
    key: '1',
    code: 'Digit1',
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey
  }
  const { keybindings, settings } = useAppStore.getState()
  // Same context and policy as the handler, so badges never show for a digit the terminal keeps.
  const options = {
    context: getKeybindingContext(event.target),
    terminalShortcutPolicy: settings?.terminalShortcutPolicy
  }
  return (
    matchKeybindingDigitIndex(
      ACTIVITY_INDEX_ACTION_ID,
      probe,
      getShortcutPlatform(),
      keybindings,
      options
    ) !== null
  )
}

export type ActivityIndexHintViewport = {
  virtualItems: readonly ActivityVirtualItemDescriptor[]
  virtualRows: readonly Pick<VirtualItem, 'index' | 'start' | 'size'>[]
  scrollOffset: number
  /** Null before the list is measured; then rendered rows stand in for the visible ones. */
  viewportHeight: number | null
  /** The group header pinned to the top, which covers the row under it; null when ungrouped. */
  stickyHeaderIndex: number | null
}

/** First item index whose row is fully below the top edge and any pinned group header. */
function firstUncoveredItemIndex({
  virtualItems,
  virtualRows,
  scrollOffset,
  stickyHeaderIndex
}: ActivityIndexHintViewport): number {
  // Rows also hold the previous group's header; only the pinned one covers the top.
  const headerRow = virtualRows.find((row) => row.index === stickyHeaderIndex)
  const top = scrollOffset + (scrollOffset > 0 ? (headerRow?.size ?? 0) : 0)
  // No row starts below the top edge: nothing is fully visible, so number nothing.
  return virtualRows.find((row) => row.start >= top)?.index ?? virtualItems.length
}

/** Numbers the first nine fully visible thread rows, so a digit never selects a row off screen; badges show only while the chord is held. */
export function useActivityIndexHints(
  enabled: boolean,
  viewport: ActivityIndexHintViewport
): {
  indexHintThreads: readonly AgentPaneThread[]
  hintNumberByPaneKey: ReadonlyMap<string, number> | null
} {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const update = (event: KeyboardEvent): void => setHeld(isActivityIndexChordHeld(event))
    const reset = (): void => setHeld(false)
    addAppKeyListener('keydown', update)
    addAppKeyListener('keyup', update)
    window.addEventListener('blur', reset)
    return () => {
      removeAppKeyListener('keydown', update)
      removeAppKeyListener('keyup', update)
      window.removeEventListener('blur', reset)
      reset()
    }
  }, [enabled])

  const startIndex = firstUncoveredItemIndex(viewport)
  const { virtualItems, virtualRows, scrollOffset, viewportHeight } = viewport
  const bottom = viewportHeight === null ? Infinity : scrollOffset + viewportHeight
  const indexHintThreads = useMemo(
    () =>
      virtualRows
        .filter((row) => row.index >= startIndex && row.start + row.size <= bottom)
        .flatMap((row) => {
          const item = virtualItems[row.index]
          return item?.type === 'thread' ? [item.thread] : []
        })
        .slice(0, MAX_INDEX_HINTS),
    [virtualItems, virtualRows, startIndex, bottom]
  )
  const hintNumberByPaneKey = useMemo(
    () =>
      enabled && held
        ? new Map(indexHintThreads.map((thread, index) => [thread.paneKey, index + 1]))
        : null,
    [enabled, held, indexHintThreads]
  )
  return { indexHintThreads, hintNumberByPaneKey }
}
