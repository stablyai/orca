// A group's shown rows, drawn only where the panel shows them. Rows have two known heights (one line, or
// two with a chat line), so positions come from counts and nothing is measured. Every row keeps one keyed
// place at every size, so a group never remounts its rows as it grows or shrinks. One row is in the Tab
// order; arrows, Home and End move between rows, drawing the next one first. The row holding focus, the
// group's Tab stop, and Back's row stay drawn wherever the panel scrolls.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import type { BotItemsViewport } from './bot-items-viewport'

/** A one-line row and its 2 px gap; a row that names its chat adds a 16 px line. */
export const BOT_ITEM_ROW_PX = 30
export const BOT_ITEM_PLACED_ROW_PX = 46
/** Drawn past each edge of the panel, so a scroll shows rows already there. */
const OVERSCAN_PX = 300
/** Rows drawn while the panel's scroller isn't known yet. */
const FIRST_ROWS = 40

type Geometry = {
  total: number
  offset: (index: number) => number
  height: (index: number) => number
  /** The row at `y` px into the group, clamped to the rows. */
  indexAt: (y: number) => number
}

function uniformGeometry(count: number): Geometry {
  return {
    total: count * BOT_ITEM_ROW_PX,
    offset: (index) => index * BOT_ITEM_ROW_PX,
    height: () => BOT_ITEM_ROW_PX,
    indexAt: (y) => Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(y / BOT_ITEM_ROW_PX)))
  }
}

function mixedGeometry(tall: readonly boolean[]): Geometry {
  const offsets = [0]
  for (const placed of tall) {
    offsets.push(offsets.at(-1)! + (placed ? BOT_ITEM_PLACED_ROW_PX : BOT_ITEM_ROW_PX))
  }
  return {
    total: offsets.at(-1)!,
    offset: (index) => offsets[index] ?? 0,
    height: (index) => (offsets[index + 1] ?? 0) - (offsets[index] ?? 0),
    indexAt: (y) => {
      let low = 0
      let high = tall.length - 1
      while (low < high) {
        const middle = (low + high + 1) >> 1
        if (offsets[middle]! <= y) {
          low = middle
        } else {
          high = middle - 1
        }
      }
      return Math.max(0, low)
    }
  }
}

type Range = { start: number; end: number }

/** `uid`'s index among the rows: looked up once per rows, never per scroll. */
function useIndexOf(items: readonly BotItem[], uid: string | null): number {
  return useMemo(
    () => (uid === null ? -1 : items.findIndex((item) => item.uid === uid)),
    [items, uid]
  )
}

export function BotItemRowsWindow({
  items,
  placed,
  viewport,
  label,
  renderRow,
  backUid,
  onBackFocused
}: {
  /** The group's shown rows, in order. */
  items: readonly BotItem[]
  /** Which rows name their chat on a second line; null when none can. */
  placed: ((item: BotItem) => boolean) | null
  viewport: BotItemsViewport
  /** The group's name, which the list is announced by. */
  label: string
  /** `tabbable`: the row is the group's Tab stop. */
  renderRow: (item: BotItem, tabbable: boolean) => React.ReactNode
  /** Back's row: drawn until it has focus, then `onBackFocused`. */
  backUid: string | null
  onBackFocused: () => void
}): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null)
  const count = items.length
  // Heights follow from which rows have a chat line: in one bot's list none do, so positions are a count.
  // Keyed by those heights alone, so content changes leave the positions as they were.
  const tallKey = useMemo(
    () => (placed ? items.map((item) => (placed(item) ? '1' : '0')).join('') : ''),
    [items, placed]
  )
  const geometry = useMemo(
    () =>
      tallKey.includes('1')
        ? mixedGeometry([...tallKey].map((flag) => flag === '1'))
        : uniformGeometry(count),
    [count, tallKey]
  )
  const [range, setRange] = useState<Range>({ start: 0, end: Math.min(count, FIRST_ROWS) })
  const measure = useCallback(() => {
    const box = viewport.read()
    const element = container.current
    let next: Range
    if (!box || !element) {
      next = { start: 0, end: Math.min(count, FIRST_ROWS) }
    } else {
      const top = element.getBoundingClientRect().top
      const from = box.top - top - OVERSCAN_PX
      const to = box.bottom - top + OVERSCAN_PX
      next =
        count === 0 || to <= 0 || from >= geometry.total
          ? { start: 0, end: 0 }
          : { start: geometry.indexAt(Math.max(0, from)), end: geometry.indexAt(to) + 1 }
    }
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [viewport, geometry, count])
  useLayoutEffect(() => {
    measure()
    return viewport.subscribe(measure)
  }, [measure, viewport])

  // Focus inside a row keeps it drawn; the last row focused stays the group's Tab stop. A window losing
  // focus (Orca in the background) keeps both, so the row is there when Orca comes back.
  const [focusedUid, setFocusedUid] = useState<string | null>(null)
  // Until a row is focused, the Tab stop is the row first shown, wherever updates move it.
  const [stopUid, setStopUid] = useState<string | null>(() => items[0]?.uid ?? null)
  // The row an arrow moved to: drawn, then focused as it mounts.
  const [targetUid, setTargetUid] = useState<string | null>(null)
  const stopIndex = useIndexOf(items, stopUid)
  const tabStop = stopIndex >= 0 ? stopIndex : 0
  const focusedIndex = useIndexOf(items, focusedUid)
  const targetIndex = useIndexOf(items, targetUid)
  const backIndex = useIndexOf(items, backUid)
  const pinned = useMemo(
    () =>
      [tabStop, focusedIndex, targetIndex, backIndex].filter(
        (index) => index >= 0 && index < count && (index < range.start || index >= range.end)
      ),
    [tabStop, focusedIndex, targetIndex, backIndex, count, range]
  )
  const drawn = useMemo(() => {
    const indexes = new Set(pinned)
    for (let index = range.start; index < Math.min(range.end, count); index++) {
      indexes.add(index)
    }
    return [...indexes].sort((a, b) => a - b)
  }, [pinned, range, count])

  const focusTarget = useCallback((node: HTMLElement | null) => {
    if (node) {
      node.querySelector<HTMLElement>('[data-bot-item-open]')?.focus()
      setTargetUid(null)
    }
  }, [])
  const focusBack = useCallback(
    (node: HTMLElement | null) => {
      if (node) {
        // Back is a command, not navigation: Esc would otherwise draw Chromium's keyboard ring here.
        node
          .querySelector<HTMLElement>('[data-bot-item-open]')
          ?.focus({ preventScroll: true, focusVisible: false })
        node.scrollIntoView({ block: 'nearest' })
        onBackFocused()
      }
    },
    [onBackFocused]
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Keys from a row's open menu reach here through its portal; the menu owns those.
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) {
      return
    }
    const at = Number(
      event.target.closest<HTMLElement>('[data-bot-item-index]')?.dataset.botItemIndex ?? -1
    )
    if (at < 0) {
      return
    }
    const next =
      event.key === 'ArrowDown'
        ? Math.min(count - 1, at + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? count - 1
              : at
    if (next === at || !items[next]) {
      return
    }
    event.preventDefault()
    setTargetUid(items[next].uid)
  }

  return (
    <div
      ref={container}
      role="list"
      aria-label={label}
      className="relative -mb-0.5"
      style={{ height: geometry.total }}
      onKeyDown={onKeyDown}
    >
      {drawn.map((index) => {
        const item = items[index]!
        return (
          <div
            key={item.uid}
            role="listitem"
            aria-posinset={index + 1}
            aria-setsize={count}
            data-bot-item-index={index}
            className="absolute inset-x-0"
            style={{ top: geometry.offset(index), height: geometry.height(index) }}
            ref={
              item.uid === targetUid
                ? focusTarget
                : item.uid === backUid
                  ? focusBack
                  : undefined
            }
            onFocus={() => {
              setFocusedUid(item.uid)
              setStopUid(item.uid)
            }}
            onBlur={(event) => {
              if (document.hasFocus() && !event.currentTarget.contains(event.relatedTarget)) {
                setFocusedUid(null)
              }
            }}
          >
            {renderRow(item, index === tabStop)}
          </div>
        )
      })}
    </div>
  )
}
