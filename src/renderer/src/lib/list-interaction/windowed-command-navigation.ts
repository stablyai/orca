import { useEffect, type RefObject } from 'react'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'

type CommandNavigationKeyEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  defaultPrevented: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

/** Resolves cmdk's movement keys over the full logical list, because cmdk only sees a windowed list's mounted rows.
 * Returns null for keys cmdk would not treat as movement; `targetId` null means movement with nowhere to go. */
export function getWindowedCommandNavigation(
  event: CommandNavigationKeyEvent,
  itemIds: readonly string[],
  activeItemId: string | null | undefined,
  options: { loop?: boolean } = {}
): { targetId: string | null } | null {
  if (event.defaultPrevented || isImeOwnedKeyboardEvent(event)) {
    return null
  }
  const last = itemIds.length - 1
  const move = (delta: 1 | -1): number | null => {
    if (event.metaKey) {
      return delta === 1 ? last : 0
    }
    const currentIndex = activeItemId ? itemIds.indexOf(activeItemId) : -1
    const next = currentIndex + delta
    if (options.loop) {
      return next < 0 ? last : next > last ? 0 : next
    }
    return next < 0 || next > last ? null : next
  }
  let targetIndex: number | null
  switch (event.key) {
    case 'ArrowDown':
      targetIndex = move(1)
      break
    case 'ArrowUp':
      targetIndex = move(-1)
      break
    case 'n':
    case 'j':
      if (!event.ctrlKey) {
        return null
      }
      targetIndex = move(1)
      break
    case 'p':
    case 'k':
      if (!event.ctrlKey) {
        return null
      }
      targetIndex = move(-1)
      break
    case 'Home':
      targetIndex = 0
      break
    case 'End':
      targetIndex = last
      break
    default:
      return null
  }
  return { targetId: targetIndex === null ? null : (itemIds[targetIndex] ?? null) }
}

/** cmdk derives `aria-activedescendant` from its own item registry; point it at the surface-owned active option after each commit. */
export function useCommandInputActiveDescendant(
  inputRef: RefObject<HTMLInputElement | null>,
  activeOptionId: string | null
): void {
  useEffect(() => {
    const input = inputRef.current
    if (!input) {
      return
    }
    if (activeOptionId) {
      input.setAttribute('aria-activedescendant', activeOptionId)
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  })
}
