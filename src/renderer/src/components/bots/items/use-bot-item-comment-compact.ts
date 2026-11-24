import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const RESIZE_MS = 140

/** Whether the comment box sits as one compact row: until focus comes into it, and again once focus
 *  leaves it empty. `held` (text, files, a recording, a list open) keeps it full whatever the focus;
 *  `stepping` keeps the stepper's loading feedback visible while the arrows wait on a read.
 *  A press inside the box never folds it, even on its padding or a control that drops focus as it
 *  goes; a window losing focus (a file picker, another app) leaves the box as it was.
 *  The box's height eases between the two (none under reduced motion). */
export function useBotItemCommentCompact(
  box: RefObject<HTMLDivElement | null>,
  held: boolean,
  stepping: boolean
): {
  compact: boolean
  handlers: {
    onFocus: () => void
    onBlur: () => void
    onPointerDown: (event: React.PointerEvent) => void
  }
} {
  // Each item mounts its own box: stepped to from the last one's text or arrows, it opens as that one
  // was, so focus has its place to come back to; the check below settles it once it has.
  const [focused, setFocused] = useState(() => stepping || arrowFocused())
  const press = useRef<{ release: () => void } | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stepRef = useRef(stepping)
  // After the event that moved focus has run its course (a click's own refocus included).
  const recheck = useCallback((): void => {
    if (settle.current) {
      clearTimeout(settle.current)
    }
    settle.current = setTimeout(() => {
      settle.current = null
      if (press.current || stepRef.current) {
        return
      }
      const node = box.current
      setFocused(Boolean(node && node.contains(document.activeElement)))
    }, 0)
  }, [box])
  useLayoutEffect(() => {
    stepRef.current = stepping
    // After mounting or a step's read, settle on where focus is now.
    if (!stepping) {
      recheck()
    }
  }, [recheck, stepping])
  useEffect(
    () => () => {
      if (settle.current) {
        clearTimeout(settle.current)
      }
      press.current?.release()
    },
    []
  )
  const compact = !focused && !held && !stepping
  useBoxResizeEase(box, compact)
  return {
    compact,
    handlers: {
      onFocus: () => setFocused(true),
      onBlur: recheck,
      onPointerDown: (event) => {
        press.current?.release()
        const { pointerId } = event
        const end = (up: PointerEvent): void => {
          if (up.pointerId === pointerId) {
            release()
            recheck()
          }
        }
        const release = (): void => {
          press.current = null
          window.removeEventListener('pointerup', end, true)
          window.removeEventListener('pointercancel', end, true)
        }
        press.current = { release }
        window.addEventListener('pointerup', end, true)
        window.addEventListener('pointercancel', end, true)
      }
    }
  }
}

/** Focus is in an item's comment box or on an arrow: read as the next item's box renders, while the
 *  last item's box still holds it. */
function arrowFocused(): boolean {
  const active = document.activeElement
  return (
    active instanceof HTMLElement &&
    (active.hasAttribute('data-bot-item-step') ||
      active.closest('[data-bot-item-comment]') !== null)
  )
}

/** Eases the box from the height it shows to its new one as `compact` flips, even mid-ease. */
function useBoxResizeEase(box: RefObject<HTMLDivElement | null>, compact: boolean): void {
  const last = useRef<number | null>(null)
  const first = useRef(true)
  const easing = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    const node = box.current
    if (!node) {
      return
    }
    // Mid-ease, the box shows the ease's height, not the last one measured.
    const running = easing.current?.playState === 'running'
    const from = running ? node.getBoundingClientRect().height : last.current
    easing.current?.cancel()
    easing.current = null
    const to = node.getBoundingClientRect().height
    last.current = to
    if (first.current) {
      first.current = false
      return
    }
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (from === null || Math.abs(from - to) < 0.5 || still || typeof node.animate !== 'function') {
      return
    }
    const ease = node.animate(
      [
        { height: `${from}px`, overflow: 'hidden' },
        { height: `${to}px`, overflow: 'hidden' }
      ],
      { duration: RESIZE_MS, easing: 'ease-out' }
    )
    easing.current = ease
    // Content that grew during the ease (a late attachment) is measured once it lets go.
    ease.onfinish = () => {
      if (easing.current === ease) {
        easing.current = null
        last.current = node.getBoundingClientRect().height
      }
    }
  }, [box, compact])
  // Its height between flips: what the next ease starts from.
  useEffect(() => {
    const node = box.current
    if (!node || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (easing.current?.playState !== 'running') {
        last.current = node.getBoundingClientRect().height
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [box])
}
