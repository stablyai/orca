// A group's shown rows, drawn only where the panel shows them. Rows have two known heights (one line, or
// two with a chat line), so positions come from counts and nothing is measured. Every row keeps one keyed
// place at every size, so a group never remounts its rows as it grows or shrinks. One row is in the Tab
// order; arrows, Home and End move between rows, drawing the next one first. The row holding focus, the
// group's Tab stop, and Back's row stay drawn wherever the panel scrolls. A short group draws every row
// and leaves Tab and the keys to the panel, as a plain list does.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { useLatestHandler } from '@/lib/use-latest-handler'
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

type IndexOf = (pick: RowPick | null) => number

/** Finds picks in one shown list: at once where they were, else by one index of the list, built on the
 *  first miss and shared by every pick. -1 for a row that left. */
function indexOfPicks(items: readonly BotItem[]): IndexOf {
  let byUid: Map<string, number> | null = null
  return (pick) => {
    if (pick === null) {
      return -1
    }
    if (items[pick.at]?.uid === pick.uid) {
      return pick.at
    }
    byUid ??= new Map(items.map((item, index) => [item.uid, index]))
    return byUid.get(pick.uid) ?? -1
  }
}

const relocated = (pick: RowPick | null, at: number): RowPick | null =>
  pick === null || pick.at === at ? pick : at < 0 ? null : { uid: pick.uid, at }

/** The rows at the top of the view and just below it, where each was, and the scroll offset then. */
type Anchor = {
  top: RowPick
  topAt: number
  below: RowPick | null
  belowAt: number
  scrollTop: number
}

/** How far what the owner was reading moved. Of the two rows, the one that moved least kept its place
 *  among its neighbours: a row an update sorts to the front doesn't take the view with it. */
function anchorShift(held: Anchor, indexOf: IndexOf, geometry: Geometry): number {
  const top = indexOf(held.top)
  const below = indexOf(held.below)
  const topShift = top < 0 ? null : geometry.offset(top) - held.topAt
  const belowShift = below < 0 ? null : geometry.offset(below) - held.belowAt
  if (topShift === null || belowShift === null) {
    return topShift ?? belowShift ?? 0
  }
  return Math.abs(belowShift) < Math.abs(topShift) ? belowShift : topShift
}

const samePick = (a: RowPick | null, b: RowPick | null): boolean =>
  a === b || (a !== null && b !== null && a.uid === b.uid && a.at === b.at)

/** Back's row: focused and scrolled to. Back is a command, not navigation: Esc would otherwise draw
 *  Chromium's keyboard ring here. */
export function focusBotItemBackRow(row: HTMLElement | null | undefined): void {
  row
    ?.querySelector<HTMLElement>('[data-bot-item-open]')
    ?.focus({ preventScroll: true, focusVisible: false })
  row?.scrollIntoView({ block: 'nearest' })
}

const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End'])

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
  /** `tabbable`: the row is in the Tab order. */
  renderRow: (item: BotItem, tabbable: boolean) => React.ReactNode
  /** Back's row: drawn until it has focus, then `onBackFocused`. */
  backUid: string | null
  onBackFocused: () => void
}): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null)
  const count = items.length
  const all = count <= ALL_ROWS
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
  const indexOf = useMemo(() => indexOfPicks(items), [items])
  const [windowRange, setRange] = useState<Range>(() => ({
    start: 0,
    end: Math.min(count, FIRST_ROWS)
  }))
  const range = useMemo(
    () => (all ? { start: 0, end: count } : windowRange),
    [all, count, windowRange]
  )
  // Where the owner is reading, when this group spans the top of the panel's view: rows added or
  // removed above it move the view with them, so what the owner is reading stays put.
  const anchor = useRef<Anchor | null>(null)
  const measure = useLatestHandler((): void => {
    const box = viewport.read()
    const element = container.current
    const top = box && element ? element.getBoundingClientRect().top : null
    anchor.current = null
    const first = { start: 0, end: Math.min(count, FIRST_ROWS) }
    if (!box || top === null) {
      setRange((prev) => (prev.start === first.start && prev.end === first.end ? prev : first))
      return
    }
    const viewTop = box.top - top
    if (box.scrollTop > 0 && viewTop > 0 && viewTop < geometry.total) {
      const at = geometry.indexAt(viewTop)
      const below = items[at + 1]
      anchor.current = {
        top: { uid: items[at]!.uid, at },
        topAt: geometry.offset(at),
        below: below ? { uid: below.uid, at: at + 1 } : null,
        belowAt: geometry.offset(at + 1),
        scrollTop: box.scrollTop
      }
    }
    const from = box.top - top - OVERSCAN_PX
    const to = box.bottom - top + OVERSCAN_PX
    const next =
      count === 0 || to <= 0 || from >= geometry.total
        ? { start: 0, end: 0 }
        : { start: geometry.indexAt(Math.max(0, from)), end: geometry.indexAt(to) + 1 }
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  })
  // A short group draws every row and needs no view: the browser keeps its reading position, as for
  // any list. A long one listens once for as long as it windows.
  useLayoutEffect(() => (all ? undefined : viewport.subscribe(measure)), [all, viewport, measure])
  // After every render: an update can move this group (another group regrouped above it) or its rows
  // without the list changing height, which no scroll or resize would report. The kept offset is set
  // outright, so a browser clamp at the bottom of the panel isn't counted twice.
  useLayoutEffect(() => {
    if (all) {
      return
    }
    const held = anchor.current
    const moved = held ? anchorShift(held, indexOf, geometry) : 0
    if (held && moved !== 0) {
      viewport.scrollTo(held.scrollTop + moved)
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
  const backPick = useMemo(() => (backUid === null ? null : { uid: backUid, at: 0 }), [backUid])
  const stopIndex = useMemo(() => indexOf(stop), [indexOf, stop])
  const focusedIndex = useMemo(() => indexOf(focused), [indexOf, focused])
  const targetIndex = useMemo(() => indexOf(target), [indexOf, target])
  const backIndex = useMemo(() => indexOf(backPick), [indexOf, backPick])
  // A row that moved is found at its new place from now on, and one that left is let go, so later
  // updates find each pick at once. A pick set since this render (focus as a row mounts) is kept.
  useLayoutEffect(() => {
    setStop((prev) => (prev === stop ? relocated(prev, stopIndex) : prev))
    setFocused((prev) => (prev === focused ? relocated(prev, focusedIndex) : prev))
    setTarget((prev) => (prev === target ? relocated(prev, targetIndex) : prev))
  }, [stop, stopIndex, focused, focusedIndex, target, targetIndex])
  const tabStop = Math.max(0, stopIndex)
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
        focusBotItemBackRow(node)
        onBackFocused()
      }
    },
    [onBackFocused]
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // A short group leaves the keys to the panel. Keys from a row's open menu reach here through its
    // portal, and a menu trigger opens its menu on Arrow Down: the menu owns those. Modified keys are the
    // system's (Cmd+Up scrolls to the top).
    if (
      all ||
      !NAVIGATION_KEYS.has(event.key) ||
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
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? count - 1
          : Math.min(count - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
    const item = items[next]
    if (next === at || !item) {
      return
    }
    event.preventDefault()
    setTarget({ uid: item.uid, at: next })
  }

  return (
    // A long group is a grid, the role assistive tech knows may be partly drawn: it says how many rows
    // there are and which one this is, and moves between rows with the arrows.
    <div
      ref={container}
      role={all ? 'list' : 'grid'}
      aria-label={label}
      aria-rowcount={all ? undefined : count}
      className="relative -mb-0.5"
      style={{ height: geometry.total }}
      onKeyDown={onKeyDown}
    >
      {drawn.map((index) => {
        const item = items[index]!
        return (
          <div
            key={item.uid}
            role={all ? 'listitem' : 'row'}
            aria-rowindex={all ? undefined : index + 1}
            data-bot-item-index={index}
            // A window keeps the reading position itself, so the browser mustn't anchor on its rows.
            className={cn('absolute inset-x-0', !all && '[overflow-anchor:none]')}
            style={{ top: geometry.offset(index), height: geometry.height(index) }}
            ref={index === targetIndex ? focusTarget : index === backIndex ? focusBack : undefined}
            onFocus={() => {
              const pick = { uid: item.uid, at: index }
              // Focus moving between a row's own controls changes nothing here.
              setFocused((prev) => (samePick(prev, pick) ? prev : pick))
              setStop((prev) => (samePick(prev, pick) ? prev : pick))
            }}
            onBlur={(event) => {
              if (document.hasFocus() && !event.currentTarget.contains(event.relatedTarget)) {
                setFocused(null)
              }
            }}
          >
            {/* The cell wraps the row at every size, so crossing into a grid remounts nothing. */}
            <div role={all ? undefined : 'gridcell'}>
              {renderRow(item, all || index === tabStop)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
