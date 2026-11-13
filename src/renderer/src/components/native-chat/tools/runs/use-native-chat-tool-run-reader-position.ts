import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { NativeChatRunPosition } from '../../messages/disclosure/native-chat-disclosure-store'
import type { NativeChatToolRunRow } from './native-chat-tool-run-rows'
import { ROW_KEY_ATTRIBUTE } from './use-native-chat-tool-run-pins'
import type { NativeChatToolRunVirtualizer } from './use-native-chat-tool-run-window'

const REVEAL_EVENT = 'native-chat-tool-run-reveal'
// A card can reveal in the same commit that mounts its run, before the run listens for it.
const unclaimedReveals = new WeakSet<Element>()
// Confirmation frames a landing may spend per real change before it waits for the next one.
const MAX_LANDING_FRAMES = 12

/** A card has just scrolled itself to the top of its run: that is now the reader's place. */
export function claimNativeChatToolRunReveal(scroller: HTMLElement): void {
  unclaimedReveals.add(scroller)
  scroller.dispatchEvent(new Event(REVEAL_EVENT))
}

/** A thought with no words draws nothing, so it can never be anyone's place. */
const drawsSomething = (row: NativeChatToolRunRow): boolean => row.kind !== 'aside' || row.focusable

// `seen` is the size and row list the frame budget was granted for; a real change grants a new budget.
type Landing = {
  target: NativeChatRunPosition
  frames: number
  seen?: { totalSize: number; rowIndexByKey: ReadonlyMap<string, number> }
}

/** The run's one record of where its reader is, and the one landing that may move the box back there. */
export function useNativeChatToolRunReaderPosition({
  scrollerRef,
  virtualizer,
  rows,
  rowIndexByKey,
  isVisible,
  followsEndRef,
  marks,
  totalSize,
  initial,
  setHeldRowKey,
  onRevealed
}: {
  scrollerRef: React.RefObject<HTMLDivElement | null>
  virtualizer: NativeChatToolRunVirtualizer
  rows: readonly NativeChatToolRunRow[]
  rowIndexByKey: ReadonlyMap<string, number>
  isVisible: boolean
  followsEndRef: React.RefObject<boolean>
  marks: ProgrammaticScrollMarks
  totalSize: number
  /** A returning reader's place, landed once the run is visible. */
  initial: NativeChatRunPosition | undefined
  /** Keeps the landing row drawn while a landing is pending. */
  setHeldRowKey: (key: string | undefined) => void
  /** A reveal took the box: no follow may move it. */
  onRevealed: () => void
}) {
  const positionRef = useRef<NativeChatRunPosition | null>(initial ?? null)
  const landingRef = useRef<Landing | null>(initial ? { target: initial, frames: 0 } : null)
  const [landingWake, setLandingWake] = useState(0)
  // Each row's first drawing row at or after it, so finding a place never walks the run.
  const nextDrawing = useMemo(() => {
    const next = new Int32Array(rows.length).fill(-1)
    for (let index = rows.length - 1; index >= 0; index--) {
      next[index] = drawsSomething(rows[index]!) ? index : (next[index + 1] ?? -1)
    }
    return next
  }, [rows])
  const isVisibleRef = useRef(isVisible)
  const latest = useRef({ virtualizer, rows, nextDrawing, onRevealed })
  useLayoutEffect(() => {
    isVisibleRef.current = isVisible
    latest.current = { virtualizer, rows, nextDrawing, onRevealed }
  })

  const retireLanding = useCallback(() => {
    if (landingRef.current) {
      landingRef.current = null
      setHeldRowKey(undefined)
    }
  }, [setHeldRowKey])
  /** The reader's row in the window's full measurement model, which also covers rows not drawn. */
  const capture = useCallback((scrollTop: number) => {
    const { virtualizer: model, rows: current, nextDrawing: next } = latest.current
    const found = model.getVirtualItemForOffset(scrollTop)?.index
    const index = found === undefined ? -1 : (next[found] ?? -1)
    const row = current[index]
    const measured = model.measurementsCache[index]
    // No drawing row there (or nothing measured yet) keeps the last place rather than inventing one.
    if (row && measured) {
      positionRef.current = { key: row.key, offset: Math.max(0, scrollTop - measured.start) }
    }
  }, [])

  /** Every scroll of the visible box: the reader's own retires any landing first, in every drawing mode. */
  const onScrolled = useCallback(
    (scrollTop: number, byReader: boolean) => {
      if (!isVisibleRef.current) {
        return
      }
      if (byReader) {
        retireLanding()
      } else if (landingRef.current) {
        return
      }
      capture(scrollTop)
    },
    [capture, retireLanding]
  )

  // A reveal in this commit (from the live listener or a claim left before this run listened) owns the box.
  const revealedRef = useRef(false)
  const takeReveal = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !unclaimedReveals.delete(scroller)) {
      return
    }
    revealedRef.current = true
    retireLanding()
    latest.current.onRevealed()
    if (isVisibleRef.current) {
      capture(scroller.scrollTop)
    }
  }, [capture, retireLanding, scrollerRef])
  useLayoutEffect(takeReveal)

  // A hidden box has no geometry: hiding keeps the place (a pending landing's target), showing lands on it
  // again unless a reveal in the same commit took the box.
  const wasVisibleRef = useRef(isVisible)
  useLayoutEffect(() => {
    if (wasVisibleRef.current === isVisible) {
      return
    }
    wasVisibleRef.current = isVisible
    const target = landingRef.current?.target ?? positionRef.current
    if (!isVisible) {
      positionRef.current = target
      retireLanding()
    } else if (target && !followsEndRef.current && !revealedRef.current) {
      positionRef.current = target
      landingRef.current = { target, frames: 0 }
      setHeldRowKey(target.key)
      setLandingWake((count) => count + 1)
    }
  }, [followsEndRef, isVisible, retireLanding, setHeldRowKey])

  // The reveal's own place, read once visibility is current; the next commit may restore again.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (revealedRef.current && scroller && isVisibleRef.current) {
      capture(scroller.scrollTop)
    }
    revealedRef.current = false
  })
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    scroller?.addEventListener(REVEAL_EVENT, takeReveal)
    return () => scroller?.removeEventListener(REVEAL_EVENT, takeReveal)
  }, [scrollerRef, takeReveal])

  // Moves the box toward the landing row. A correction owns one confirmation frame; past the frame budget the
  // landing keeps its row drawn and waits for a size, row-list, measurement or visibility change.
  useLayoutEffect(() => {
    const landing = landingRef.current
    const scroller = scrollerRef.current
    if (!landing || !scroller || !isVisible) {
      return
    }
    if (landing.seen?.totalSize !== totalSize || landing.seen.rowIndexByKey !== rowIndexByKey) {
      landing.seen = { totalSize, rowIndexByKey }
      landing.frames = 0
    }
    const found = rowIndexByKey.get(landing.target.key)
    const index = found === undefined ? -1 : (nextDrawing[found] ?? -1)
    const row = rows[index]
    if (!row) {
      retireLanding()
      return
    }
    if (row.key !== landing.target.key) {
      landing.target = { key: row.key, offset: 0 }
      setHeldRowKey(row.key)
    }
    const element = scroller.querySelector(`[${ROW_KEY_ATTRIBUTE}="${CSS.escape(row.key)}"]`)
    const rect = element?.getBoundingClientRect()
    const laidOut = rect !== undefined && rect.height > 0
    const delta = laidOut
      ? rect.top - scroller.getBoundingClientRect().top + landing.target.offset
      : (virtualizer.measurementsCache[index]?.start ?? scroller.scrollTop) +
        landing.target.offset -
        scroller.scrollTop
    const atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1
    if (laidOut && (Math.abs(delta) <= 1 || (delta > 0 && atEnd))) {
      positionRef.current = landing.target
      retireLanding()
      return
    }
    if (Math.abs(delta) > 1) {
      marks.mark(scroller.scrollTop + delta)
      scroller.scrollTop += delta
    } else if (laidOut) {
      return
    }
    if (landing.frames >= MAX_LANDING_FRAMES) {
      return
    }
    landing.frames++
    const frame = window.requestAnimationFrame(() => {
      if (landingRef.current === landing && isVisibleRef.current) {
        setLandingWake((count) => count + 1)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    isVisible,
    landingWake,
    marks,
    nextDrawing,
    retireLanding,
    rowIndexByKey,
    rows,
    scrollerRef,
    setHeldRowKey,
    totalSize,
    virtualizer
  ])

  /** The held row reported a real size: a waiting landing tries again, with a fresh confirmation budget. */
  const onRowMeasured = useCallback((key: string) => {
    const landing = landingRef.current
    if (landing?.target.key === key) {
      landing.frames = 0
      setLandingWake((count) => count + 1)
    }
  }, [])
  /** A landing is still moving the box: its own writes are not the reader arriving at the end. */
  const landingPending = useCallback((): boolean => landingRef.current !== null, [])
  /** What the run keeps when it leaves: a pending landing's target is still the reader's place. */
  const current = useCallback(
    (): NativeChatRunPosition | null => landingRef.current?.target ?? positionRef.current,
    []
  )
  return useMemo(
    () => ({ onScrolled, onRowMeasured, current, landingPending }),
    [current, landingPending, onRowMeasured, onScrolled]
  )
}
