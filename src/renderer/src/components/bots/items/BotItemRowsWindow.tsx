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
/** A group this short draws every row and keeps each in the Tab order, as a plain list would. */
const ALL_ROWS = 50

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

/** A row by its uid and where it was: found there at once unless the rows have moved since. */
type RowPick = { uid: string; at: number }

function indexOfPick(items: readonly BotItem[], pick: RowPick | null): number {
  if (pick === null) {
    return -1
  }
  return items[pick.at]?.uid === pick.uid
    ? pick.at
    : items.findIndex((item) => item.uid === pick.uid)
}

function useIndexOf(items: readonly BotItem[], pick: RowPick | null): number {
  return useMemo(() => indexOfPick(items, pick), [items, pick])
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
  const all = count <= ALL_ROWS
  const [range, setRange] = useState<Range>({ start: 0, end: Math.min(count, FIRST_ROWS) })
  // The row at the top of the panel's view, when this group spans it: rows added or removed above it
  // move the view with them, so what the owner is reading stays put.
  const anchor = useRef<(RowPick & { offset: number }) | null>(null)
  const measure = useCallback(() => {
    const box = viewport.read()
    const element = container.current
    const top = box && element ? element.getBoundingClientRect().top : null
    anchor.current = null
    if (box && top !== null) {
      const viewTop = box.top - top
      if (viewTop > 0 && viewTop < geometry.total) {
        const at = geometry.indexAt(viewTop)
        anchor.current = { uid: items[at]!.uid, at, offset: geometry.offset(at) }
      }
    }
    let next: Range
    if (all) {
      next = { start: 0, end: count }
    } else if (!box || top === null) {
      next = { start: 0, end: Math.min(count, FIRST_ROWS) }
    } else {
      const from = box.top - top - OVERSCAN_PX
      const to = box.bottom - top + OVERSCAN_PX
      next =
        count === 0 || to <= 0 || from >= geometry.total
          ? { start: 0, end: 0 }
          : { start: geometry.indexAt(Math.max(0, from)), end: geometry.indexAt(to) + 1 }
    }
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [viewport, geometry, count, all, items])
  useLayoutEffect(() => viewport.subscribe(measure), [measure, viewport])
  // After every render: an update can move this group (another group regrouped above it) or its rows
  // without the list changing height, which no scroll or resize would report.
  useLayoutEffect(() => {
    const held = anchor.current
    const at = indexOfPick(items, held)
    if (held && at >= 0) {
      viewport.keep(geometry.offset(at) - held.offset)
    }
    measure()
  })

  // Focus inside a row keeps it drawn; the last row focused stays the group's Tab stop. A window losing
  // focus (Orca in the background) keeps both, so the row is there when Orca comes back.
  const [focused, setFocused] = useState<RowPick | null>(null)
  // Until a row is focused, the Tab stop is the row first shown, wherever updates move it.
  const [stop, setStop] = useState<RowPick | null>(() =>
    items[0] ? { uid: items[0].uid, at: 0 } : null
  )
  // The row an arrow moved to: drawn, then focused as it mounts.
  const [target, setTarget] = useState<RowPick | null>(null)
  const backPick = useMemo(
    () => (backUid === null ? null : { uid: backUid, at: 0 }),
    [backUid]
  )
  const stopIndex = useIndexOf(items, stop)
  const tabStop = stopIndex >= 0 ? stopIndex : 0
  const focusedIndex = useIndexOf(items, focused)
  const targetIndex = useIndexOf(items, target)
  const backIndex = useIndexOf(items, backPick)
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
      setTarget(null)
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
    // Keys from a row's open menu reach here through its portal, and a menu trigger opens its menu on
    // Arrow Down: the menu owns those. Modified arrows are the system's (Cmd+Up scrolls to the top).
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !(event.target instanceof Element) ||
      !event.currentTarget.contains(event.target)
    ) {
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
    setTarget({ uid: items[next].uid, at: next })
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
            // The window keeps the reading position itself, so the browser mustn't anchor on a row.
            className="absolute inset-x-0 [overflow-anchor:none]"
            style={{ top: geometry.offset(index), height: geometry.height(index) }}
            ref={
              index === targetIndex
                ? focusTarget
                : index === backIndex
                  ? focusBack
                  : undefined
            }
            onFocus={() => {
              const pick = { uid: item.uid, at: index }
              setFocused(pick)
              setStop(pick)
            }}
            onBlur={(event) => {
              if (document.hasFocus() && !event.currentTarget.contains(event.relatedTarget)) {
                setFocused(null)
              }
            }}
          >
            {renderRow(item, all || index === tabStop)}
          </div>
        )
      })}
    </div>
  )
}
