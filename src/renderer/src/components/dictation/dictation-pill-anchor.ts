import { useLayoutEffect, useState } from 'react'
import type { DictationInsertionTarget } from './dictation-insertion-target'

/** The pane the words go to; the pill floats over its bottom edge, or just above a chat composer. */
export type DictationPillAnchor = { element: HTMLElement; placement: 'over' | 'above' }

/** Fixed-position box: `left` is the pill's centre, `bottom` its distance from the window's bottom edge. */
export type DictationPillBox = { left: number; bottom: number; width: number }

const PILL_MAX_WIDTH = 440
const PANE_INSET = 16
const OVER_GAP = 12
const ABOVE_GAP = 8

export function dictationPillAnchorFor(
  target: DictationInsertionTarget | null
): DictationPillAnchor | null {
  if (target?.kind === 'composer') {
    return { element: target.root, placement: 'above' }
  }
  if (target?.kind === 'terminal') {
    const tab = document.querySelector(`[data-terminal-tab-id="${CSS.escape(target.tabId)}"]`)
    const pane = tab?.querySelector<HTMLElement>(`.pane[data-pane-id="${target.paneId}"]`)
    return pane ? { element: pane, placement: 'over' } : null
  }
  return null
}

function readPillBox(anchor: DictationPillAnchor): DictationPillBox | null {
  const { element, placement } = anchor
  if (!element.isConnected || !element.checkVisibility({ visibilityProperty: true })) {
    return null
  }
  const rect = element.getBoundingClientRect()
  if (rect.width <= PANE_INSET * 2 || rect.height === 0) {
    return null
  }
  const edge = placement === 'above' ? rect.top - ABOVE_GAP : rect.bottom - OVER_GAP
  return {
    left: rect.left + rect.width / 2,
    bottom: window.innerHeight - edge,
    width: Math.min(PILL_MAX_WIDTH, rect.width - PANE_INSET * 2)
  }
}

/** Follows the anchor pane's size; once it's hidden or gone, null puts the pill at the window's bottom centre. */
export function useDictationPillBox(anchor: DictationPillAnchor | null): DictationPillBox | null {
  const [box, setBox] = useState<DictationPillBox | null>(null)
  useLayoutEffect(() => {
    if (!anchor) {
      setBox(null)
      return
    }
    const update = (): void => setBox(readPillBox(anchor))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(anchor.element)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [anchor])
  return box
}
