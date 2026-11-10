import { useLayoutEffect, useState, type RefObject } from 'react'

/** Gap between the waking pill and the edges of the terminal it sits over. */
export const TERMINAL_CONTENT_INSET_PX = 8

export type TerminalContentInset = { top: number; right: number }

/** The terminal the person is in (it holds focus), else the first one showing. */
function frontTerminal(scope: HTMLElement): HTMLElement | null {
  const focused = document.activeElement?.closest?.('.xterm')
  if (focused instanceof HTMLElement && scope.contains(focused)) {
    return focused
  }
  for (const element of Array.from(scope.querySelectorAll('.xterm'))) {
    if (element instanceof HTMLElement && element.getBoundingClientRect().width > 0) {
      return element
    }
  }
  return null
}

/** Where the pill goes, relative to `anchor`'s parent: inside the terminal content area, below
 *  the pane's tab strip (Run, split, close), so it never covers those controls. */
export function measureTerminalContentInset(anchor: HTMLElement): TerminalContentInset | null {
  const scope = anchor.parentElement?.parentElement ?? anchor.parentElement
  if (!scope) {
    return null
  }
  const terminal = frontTerminal(scope)
  if (!terminal) {
    return null
  }
  const box = anchor.getBoundingClientRect()
  const content = terminal.getBoundingClientRect()
  // The pane's header icons (split, close) are drawn over the terminal's top edge: start below them.
  let top = content.top
  for (const element of Array.from(
    scope.querySelectorAll('.pane-title-actions, .pane-title-bar')
  )) {
    const icons = element.getBoundingClientRect()
    const overlaps =
      icons.width > 0 &&
      icons.left < content.right &&
      icons.right > content.left &&
      icons.bottom > content.top &&
      icons.top < content.top + content.height / 2
    if (overlaps) {
      top = Math.max(top, icons.bottom)
    }
  }
  return {
    top: Math.max(0, Math.round(top - box.top)) + TERMINAL_CONTENT_INSET_PX,
    right: Math.max(0, Math.round(box.right - content.right)) + TERMINAL_CONTENT_INSET_PX
  }
}

/**
 * Keeps the inset current while `enabled`: on mount and whenever the anchor's area resizes (a
 * split, the sidebar). Null until measured or when no terminal is showing (callers fall back to
 * a plain top-right inset).
 */
export function useTerminalContentInset(
  anchor: RefObject<HTMLElement | null>,
  enabled: boolean
): TerminalContentInset | null {
  const [inset, setInset] = useState<TerminalContentInset | null>(null)
  useLayoutEffect(() => {
    const element = anchor.current
    if (!enabled || !element) {
      return
    }
    const update = (): void => {
      const next = measureTerminalContentInset(element)
      setInset((current) =>
        current?.top === next?.top && current?.right === next?.right ? current : next
      )
    }
    update()
    const scope = element.parentElement?.parentElement ?? element.parentElement
    if (!scope || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(update)
    observer.observe(scope)
    // Focus moving to another pane's terminal moves the pill with it.
    document.addEventListener('focusin', update)
    return () => {
      observer.disconnect()
      document.removeEventListener('focusin', update)
    }
  }, [anchor, enabled])
  return inset
}
