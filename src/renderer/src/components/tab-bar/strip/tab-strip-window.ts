import { useLayoutEffect, useState, type RefObject } from 'react'

/** Overflowing tabs sit at their 144px minimum (tab-width-rules.ts), so unmounted runs need no measuring. */
export const TAB_STRIP_WINDOW_SLOT_PX = 144
/** Below this every tab renders; at this count the minimum widths alone overflow any pane. */
export const TAB_STRIP_WINDOW_MIN_TABS = 100
// Snap range edges so scrolling re-renders once per block of tabs, not per frame.
const WINDOW_BLOCK = 16

export type TabStripRange = { start: number; end: number }

export type TabStripSegment =
  | { kind: 'tabs'; start: number; end: number }
  | { kind: 'gap'; start: number; end: number }

/** Tabs to mount: the viewport plus one viewport each side; null renders every tab. */
export function computeTabStripRange(
  count: number,
  scrollLeft: number,
  viewportWidth: number
): TabStripRange | null {
  if (count < TAB_STRIP_WINDOW_MIN_TABS) {
    return null
  }
  const perView = Math.max(1, Math.ceil(viewportWidth / TAB_STRIP_WINDOW_SLOT_PX))
  const first = Math.floor(Math.max(0, scrollLeft) / TAB_STRIP_WINDOW_SLOT_PX)
  const start = Math.max(0, Math.floor((first - perView) / WINDOW_BLOCK) * WINDOW_BLOCK)
  const end = Math.min(count, Math.ceil((first + 2 * perView) / WINDOW_BLOCK) * WINDOW_BLOCK)
  return { start, end: Math.max(end, Math.min(count, start + WINDOW_BLOCK)) }
}

/** Mounted runs and the gaps between them; `keptIndices` stay mounted at their own place in the order. */
export function buildTabStripSegments(
  count: number,
  range: TabStripRange | null,
  keptIndices: readonly number[]
): TabStripSegment[] {
  if (range === null) {
    return count > 0 ? [{ kind: 'tabs', start: 0, end: count }] : []
  }
  const runs: [number, number][] = [[range.start, range.end]]
  for (const index of keptIndices) {
    if (index >= 0 && index < count) {
      runs.push([index, index + 1])
    }
  }
  runs.sort((a, b) => a[0] - b[0])
  const segments: TabStripSegment[] = []
  let cursor = 0
  for (const [start, end] of runs) {
    if (end <= cursor) {
      continue
    }
    const from = Math.max(start, cursor)
    if (from > cursor) {
      segments.push({ kind: 'gap', start: cursor, end: from })
    }
    const last = segments.at(-1)
    if (last?.kind === 'tabs' && last.end === from) {
      last.end = end
    } else {
      segments.push({ kind: 'tabs', start: from, end })
    }
    cursor = end
  }
  if (cursor < count) {
    segments.push({ kind: 'gap', start: cursor, end: count })
  }
  return segments
}

function sameRange(a: TabStripRange | null, b: TabStripRange | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end)
}

/** Follow the strip's scroll and size; re-renders only when the mounted range moves a block. */
export function useTabStripRange(
  stripRef: RefObject<HTMLElement | null>,
  count: number,
  subscribeToStripResize: (listener: () => void) => () => void
): TabStripRange | null {
  const [range, setRange] = useState(() => computeTabStripRange(count, 0, 0))
  useLayoutEffect(() => {
    const el = stripRef.current
    const update = (): void => {
      const next = computeTabStripRange(count, el?.scrollLeft ?? 0, el?.clientWidth ?? 0)
      setRange((previous) => (sameRange(previous, next) ? previous : next))
    }
    update()
    if (!el || count < TAB_STRIP_WINDOW_MIN_TABS) {
      return
    }
    let frame = 0
    const onScroll = (): void => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0
          update()
        })
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const unsubscribe = subscribeToStripResize(update)
    return () => {
      el.removeEventListener('scroll', onScroll)
      unsubscribe()
      cancelAnimationFrame(frame)
    }
  }, [count, stripRef, subscribeToStripResize])
  return range
}

function slotIdOf(strip: HTMLElement, target: EventTarget | null): string | null {
  const slot =
    target instanceof Element ? target.closest<HTMLElement>('[data-tab-strip-slot]') : null
  return slot && strip.contains(slot) ? (slot.dataset.tabStripSlot ?? null) : null
}

/** The slot holding focus (rename input, keyboard focus), kept mounted so scrolling never drops it. */
export function useFocusedTabStripSlotId(stripRef: RefObject<HTMLElement | null>): string | null {
  const [focusedSlotId, setFocusedSlotId] = useState<string | null>(null)
  useLayoutEffect(() => {
    const el = stripRef.current
    if (!el) {
      return
    }
    const onFocusIn = (event: FocusEvent): void => setFocusedSlotId(slotIdOf(el, event.target))
    const onFocusOut = (event: FocusEvent): void =>
      setFocusedSlotId(slotIdOf(el, event.relatedTarget))
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    return () => {
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
    }
  }, [stripRef])
  return focusedSlotId
}
