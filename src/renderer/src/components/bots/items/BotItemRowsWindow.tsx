// A group's shown rows, drawn only where the panel shows them. Rows have two heights (one line, or two
// with a chat line), read from drawn rows, so positions come from counts. Drawn rows are in flow,
// with the rows not drawn standing as gaps of their height, so the browser keeps the reading position as
// for any list. Rows keep their keys at every size, so a group never remounts its rows as it grows or
// shrinks. One row is in the Tab
// order; arrows, Home and End move between rows, drawing the next one first. The row holding focus, the
// group's Tab stop, and Back's row stay drawn wherever the panel scrolls. A short group draws every row
// and leaves Tab and the keys to the panel, as a plain list does.
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { botItemsDocumentHidden, type BotItemsViewport } from './bot-items-viewport'
import {
  DEFAULT_ROW_SIZES,
  mixedGeometry,
  readRowSizes,
  uniformGeometry
} from './bot-item-rows-geometry'
import { focusFellToNothing } from '../use-needs-you-focus'

/** Drawn past each edge of the panel, so a scroll shows rows already there. */
const OVERSCAN_PX = 300
/** Rows drawn while the panel's scroller isn't known yet. */
const FIRST_ROWS = 40
/** A group this short draws every row and keeps each in the Tab order, as a plain list would. */
const ALL_ROWS = 50

type Range = { start: number; end: number }
/** A window's range, and the rows it drew there (uid and place), which an update finds again. */
type WindowRange = Range & { band: readonly RowPick[] }

function bandOf(items: readonly BotItem[], start: number, end: number): RowPick[] {
  return items.slice(start, end).map((item, offset) => ({ uid: item.uid, at: start + offset }))
}

const sameBand = (a: readonly RowPick[], b: readonly RowPick[]): boolean =>
  a.length === b.length && a.every((pick, index) => samePick(pick, b[index]!))

const NO_INDEXES: readonly number[] = []

/** A row by its uid and where it was: found there at once unless the rows have moved since. */
type RowPick = { uid: string; at: number }

type IndexOf = (pick: RowPick | null) => number
/** How far from where it was a pick is looked for before the whole list is indexed. */
const NEAR_ROWS = 8

/** Finds picks in one shown list: at once where they were, else by one index of the list, built on the
 *  first miss and shared by every pick. -1 for a row that left. */
function indexOfPicks(items: readonly BotItem[]): IndexOf {
  let byUid: Map<string, number> | null = null
  return (pick) => {
    if (pick === null) {
      return -1
    }
    // A row an update moved a few places (rows above it added, removed or sorted) is found close by.
    for (let distance = 0; distance <= NEAR_ROWS; distance++) {
      if (items[pick.at + distance]?.uid === pick.uid) {
        return pick.at + distance
      }
      if (distance > 0 && items[pick.at - distance]?.uid === pick.uid) {
        return pick.at - distance
      }
    }
    byUid ??= new Map(items.map((item, index) => [item.uid, index]))
    return byUid.get(pick.uid) ?? -1
  }
}

const relocated = (pick: RowPick | null, at: number): RowPick | null =>
  pick === null || pick.at === at ? pick : at < 0 ? null : { uid: pick.uid, at }

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
  onBackFocused,
  disabled = false
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
  /** The rows' controls are off (the host is offline): rows themselves take focus, so the keys still
   *  reach every row and a screen reader reads each one. */
  disabled?: boolean
}): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null)
  const count = items.length
  // Between half and all of ALL_ROWS a group keeps the mode it has, so updates around the threshold don't
  // remount rows; well below it (filtered down, say) it's a plain list again.
  const [windowed, setWindowed] = useState(count > ALL_ROWS)
  if (windowed !== (count > ALL_ROWS || (windowed && count > ALL_ROWS / 2))) {
    setWindowed(!windowed)
  }
  const all = windowed ? count <= ALL_ROWS / 2 : count <= ALL_ROWS
  // Heights follow from which rows have a chat line: in one bot's list none do, so positions are a count.
  // Keyed by those heights alone, so content changes leave the positions as they were.
  const tallKey = useMemo(
    () => (placed ? items.map((item) => (placed(item) ? '1' : '0')).join('') : ''),
    [items, placed]
  )
  const [sizes, setSizes] = useState(DEFAULT_ROW_SIZES)
  const sizesRead = useRef(false)
  const geometry = useMemo(
    () =>
      tallKey.includes('1')
        ? mixedGeometry(
            [...tallKey].map((flag) => flag === '1'),
            sizes
          )
        : uniformGeometry(count, sizes),
    [count, tallKey, sizes]
  )
  const indexOf = useMemo(() => indexOfPicks(items), [items])
  // This group's height changing (rows becoming one or two lines with the count unchanged) moves the
  // groups below it, even with the list's height unchanged: they measure again before it's painted.
  useLayoutEffect(() => viewport.flush(), [geometry.total, viewport])
  const [windowRange, setRange] = useState<WindowRange>(() => ({
    start: 0,
    end: Math.min(count, FIRST_ROWS),
    band: bandOf(items, 0, Math.min(count, FIRST_ROWS))
  }))
  const range = useMemo(
    (): Range => (all ? { start: 0, end: count } : windowRange),
    [all, count, windowRange]
  )
  // Rows change before the range follows them: the rows drawn until now that moved out of it stay drawn
  // wherever they went, so however many rows an update adds or removes above the view, the browser keeps
  // a row it can hold the reading position by. The range measured right after lets them go.
  const { carried, drifted } = useMemo(() => {
    if (all) {
      return { carried: NO_INDEXES, drifted: false }
    }
    const { band, start, end } = windowRange
    const now = band.map((pick) => indexOf(pick))
    const moved = now.filter((index) => index >= 0 && (index < start || index >= end))
    return {
      carried: moved.length > 0 ? moved : NO_INDEXES,
      drifted: now.some((index, offset) => index !== band[offset]!.at)
    }
  }, [all, windowRange, indexOf])
  const measure = useLatestHandler((): void => {
    const box = viewport.read()
    const element = container.current
    const rect = box && element ? element.getBoundingClientRect() : null
    const top = rect ? rect.top : null
    let next: Range = { start: 0, end: Math.min(count, FIRST_ROWS) }
    if (box && top !== null) {
      const from = box.top - top - OVERSCAN_PX
      const to = box.bottom - top + OVERSCAN_PX
      next =
        count === 0 || to <= 0 || from >= geometry.total
          ? { start: 0, end: 0 }
          : { start: geometry.indexAt(Math.max(0, from)), end: geometry.indexAt(to) + 1 }
    }
    // Heights are read from drawn rows once, then as the range moves or the group's height stops
    // matching them (the font size changed), not every scroll frame, and never for a group out of view.
    const moved = next.start !== windowRange.start || next.end !== windowRange.end
    const resized = rect !== null && Math.abs(rect.height - geometry.total) > 1
    if (element && next.end > next.start && (moved || resized || !sizesRead.current)) {
      sizesRead.current = windowRange.end > windowRange.start
      const read = readRowSizes(element, sizes)
      if (read !== sizes) {
        // New heights re-position the rows, which measures again.
        setSizes(read)
      }
    }
    // An unchanged range over the same rows (most scroll frames) builds nothing.
    setRange((prev) =>
      prev.start === next.start &&
      prev.end === next.end &&
      prev.band.every((pick) => items[pick.at]?.uid === pick.uid)
        ? prev
        : { ...next, band: bandOf(items, next.start, next.end) }
    )
  })
  // A short group draws every row and needs no view. A long one listens once for as long as it windows.
  useLayoutEffect(() => (all ? undefined : viewport.subscribe(measure)), [all, viewport, measure])
  // When the rows' positions change, the drawn range follows: an update can move this group's rows
  // without the panel scrolling or the list changing height, which no notice would report. A content
  // change leaves the positions, so it reads nothing. A hidden window measures as it shows again. A short
  // group's range is every row, kept current so it starts from there if it grows long.
  const drawAll = useLatestHandler((): void => {
    const band = bandOf(items, 0, count)
    setRange((was) =>
      was.start === 0 && was.end === count && sameBand(was.band, band)
        ? was
        : { start: 0, end: count, band }
    )
  })
  useLayoutEffect(() => {
    if (!all && !botItemsDocumentHidden()) {
      measure()
    }
  }, [all, count, geometry, measure])
  // A short group's band follows its rows (at most 50, no layout read), so crossing 50 carries them.
  useLayoutEffect(() => {
    if (all) {
      drawAll()
    }
  }, [all, items, drawAll])
  // Once the browser has laid out the carried rows (and kept its place by them), measure to let them go.
  // Rows that moved within the range need no measure: the range is re-based onto them, so later updates
  // find them where they are.
  const rebase = useLatestHandler((): void =>
    setRange((was) => {
      const band = bandOf(items, was.start, was.end)
      return sameBand(was.band, band) ? was : { ...was, band }
    })
  )
  useLayoutEffect(() => {
    if (carried.length > 0 && !botItemsDocumentHidden()) {
      measure()
    } else if (drifted && carried.length === 0) {
      rebase()
    }
  }, [carried, drifted, measure, rebase])

  // Focus inside a row keeps it drawn; the last row focused stays the group's Tab stop. A window losing
  // focus (Orca in the background) keeps both, so the row is there when Orca comes back.
  const [focused, setFocused] = useState<RowPick | null>(null)
  // Until a row is focused, the Tab stop is the group's first row, whichever that is now.
  const [stop, setStop] = useState<RowPick | null>(null)
  // A short group keeps no focus state, so growing long takes the row holding focus from the page.
  const seedFocus = useLatestHandler((): void => {
    const active = document.activeElement
    const uid = container.current?.contains(active)
      ? active?.closest<HTMLElement>('[data-bot-item-row]')?.dataset.botItemRow
      : undefined
    const at = uid === undefined ? -1 : items.findIndex((item) => item.uid === uid)
    // Picks from an earlier long phase are stale: the row focused now, or none, is where it starts.
    const pick = uid !== undefined && at >= 0 ? { uid, at } : null
    setFocused(pick)
    setStop(pick)
  })
  useLayoutEffect(() => {
    if (!all) {
      seedFocus()
    }
  }, [all, seedFocus])
  // The row an arrow moved to: drawn, then focused as it mounts (scrolled to, unless `quiet`).
  const [target, setTarget] = useState<(RowPick & { quiet?: boolean }) | null>(null)
  const backPick = useMemo(() => (backUid === null ? null : { uid: backUid, at: 0 }), [backUid])
  const stopIndex = useMemo(() => indexOf(stop), [indexOf, stop])
  const focusedIndex = useMemo(() => indexOf(focused), [indexOf, focused])
  const targetIndex = useMemo(() => indexOf(target), [indexOf, target])
  const backIndex = useMemo(() => indexOf(backPick), [indexOf, backPick])
  // A row that moved is found at its new place from now on, and one that left is let go, so later
  // updates find each pick at once. A pick set since this render (focus as a row mounts) is kept.
  // The row holding focus leaving (marked Done, say) drops focus to the page: the row now in its place
  // takes it, without scrolling, so the owner carries on from there. Only focus this commit dropped is
  // handed on; focus the owner had already taken elsewhere stays there.
  const focusedAtRender = typeof document === 'undefined' ? null : document.activeElement
  // A row the panel shows: focus handed to one out of view would act on a row the owner can't see.
  const inView = (index: number): boolean => {
    const box = viewport.read()
    const element = container.current
    if (!box || !element) {
      return false
    }
    const top = element.getBoundingClientRect().top + geometry.offset(index)
    return top < box.bottom && top + geometry.height(index) > box.top
  }
  const refocus = useLatestHandler((left: RowPick): void => {
    const index = Math.min(left.at, count - 1)
    const next = items[index]
    // The dropped control was in the row that left (still its parent, off the page), not another list's.
    const inRow =
      focusedAtRender?.closest<HTMLElement>('[data-bot-item-row]')?.dataset.botItemRow === left.uid
    if (next && inRow && !focusedAtRender?.isConnected && focusFellToNothing() && inView(index)) {
      setTarget({ uid: next.uid, at: index, quiet: true })
    }
  })
  useLayoutEffect(() => {
    if (focused !== null && focusedIndex < 0) {
      refocus(focused)
    }
    setStop((prev) => (prev === stop ? relocated(prev, stopIndex) : prev))
    setFocused((prev) => (prev === focused ? relocated(prev, focusedIndex) : prev))
    setTarget((prev) => (prev === target ? relocated(prev, targetIndex) : prev))
  }, [stop, stopIndex, focused, focusedIndex, target, targetIndex, refocus])
  const tabStop = Math.max(0, stopIndex)
  const rowsTakeFocus = disabled && !all
  const pinned = useMemo(
    () =>
      [tabStop, focusedIndex, targetIndex, backIndex].filter(
        (index) => index >= 0 && index < count && (index < range.start || index >= range.end)
      ),
    [tabStop, focusedIndex, targetIndex, backIndex, count, range]
  )
  const drawn = useMemo(() => {
    const indexes = new Set([...pinned, ...carried])
    for (let index = range.start; index < Math.min(range.end, count); index++) {
      indexes.add(index)
    }
    return [...indexes].sort((a, b) => a - b)
  }, [pinned, carried, range, count])

  const quiet = target?.quiet === true
  const focusTarget = useCallback(
    (node: HTMLElement | null) => {
      if (node) {
        const control = disabled ? node : node.querySelector<HTMLElement>('[data-bot-item-open]')
        control?.focus({ preventScroll: quiet })
        setTarget(null)
      }
    },
    [quiet, disabled]
  )
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
    // At either end the key does nothing, rather than scroll the panel while focus stays on the row.
    event.preventDefault()
    if (next === at || !item) {
      return
    }
    setTarget({ uid: item.uid, at: next })
  }

  // A long group is a grid, the role assistive tech knows may be partly drawn: it says how many rows
  // there are and which one this is, and moves between rows with the arrows.
  return (
    <div
      ref={container}
      role={all ? 'list' : 'grid'}
      aria-label={label}
      aria-rowcount={all ? undefined : count}
      className="-mb-0.5"
      onKeyDown={onKeyDown}
    >
      {drawn.map((index, at) => {
        const item = items[index]!
        const gap = geometry.offset(index) - (at === 0 ? 0 : geometry.offset(drawn[at - 1]! + 1))
        return (
          <Fragment key={item.uid}>
            <BotItemRowsGap key="gap" height={gap} />
            <div
              key="row"
              role={all ? 'listitem' : 'row'}
              aria-rowindex={all ? undefined : index + 1}
              data-bot-item-index={index}
              data-bot-item-row={item.uid}
              data-bot-item-tall={tallKey[index] === '1' ? '' : undefined}
              tabIndex={rowsTakeFocus ? (index === tabStop ? 0 : -1) : undefined}
              className="pb-0.5"
              ref={
                index === targetIndex ? focusTarget : index === backIndex ? focusBack : undefined
              }
              // A short group draws and tabs every row, so focus moving through it needs no state.
              onFocus={() => {
                if (all) {
                  return
                }
                const pick = { uid: item.uid, at: index }
                // Focus moving between a row's own controls changes nothing here.
                setFocused((prev) => (samePick(prev, pick) ? prev : pick))
                setStop((prev) => (samePick(prev, pick) ? prev : pick))
              }}
              onBlur={(event) => {
                // Focus going nowhere (the row removed, or a click on no control) keeps the row as the
                // one holding focus, so a row leaving hands focus to the next.
                if (
                  !all &&
                  document.hasFocus() &&
                  event.relatedTarget !== null &&
                  !event.currentTarget.contains(event.relatedTarget)
                ) {
                  setFocused(null)
                }
              }}
            >
              {/* The cell wraps the row at every size, so crossing into a grid remounts nothing. */}
              <div role={all ? undefined : 'gridcell'}>
                {renderRow(item, all || index === tabStop)}
              </div>
            </div>
          </Fragment>
        )
      })}
      <BotItemRowsGap
        height={geometry.total - (drawn.length ? geometry.offset(drawn.at(-1)! + 1) : 0)}
      />
    </div>
  )
}

/** Rows not drawn, as their height. Never what the browser keeps in view: it keeps a drawn row. */
function BotItemRowsGap({ height }: { height: number }): React.JSX.Element | null {
  return height > 0 ? (
    <div aria-hidden className="[overflow-anchor:none]" style={{ height }} />
  ) : null
}
