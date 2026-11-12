import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { elementScroll, measureElement, useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/class-names'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import { VIRTUALIZED_LIST_MIN_ROWS, VIRTUALIZED_LIST_OVERSCAN } from '@/components/virtualized-list'
import {
  distanceFromBottom,
  NATIVE_CHAT_FOLLOW_REARM_PX
} from '../../viewport/scroll/native-chat-autoscroll'
import { setWithLRU } from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import {
  MAX_NATIVE_CHAT_DISCLOSURES,
  NativeChatDisclosureContext
} from '../../messages/disclosure/native-chat-disclosure-store'
import { NativeChatToolRunWindowContext } from './native-chat-tool-run-window-context'
import type { NativeChatToolRunRow } from './native-chat-tool-run-rows'
import { ROW_KEY_ATTRIBUTE, useNativeChatToolRunPins } from './use-native-chat-tool-run-pins'

/** A tool line's `min-h-6.5`; measured rows replace it. */
const ROW_ESTIMATE_PX = 26

/** What this row's opened details add, the same quantity the box's cap has always grown by. */
function openedDetailHeight(row: Element): number {
  let height = 0
  for (const detail of row.querySelectorAll<HTMLElement>('[data-native-chat-member-detail]')) {
    height += detail.offsetHeight
  }
  return height
}

/** Scroll inside the run, then return its box for transcript alignment; member offsets omit internal scroll. */
export function revealNativeChatToolRunMember(member: HTMLElement): HTMLElement {
  const scroller = member.closest<HTMLElement>('[data-native-chat-tool-run-members]')
  if (!scroller) {
    return member
  }
  scroller.scrollTop += member.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  return scroller
}

/** An opened run's rows in a bounded scroll box that draws only what the reader can reach, so a long run costs a window, not its length. */
export function NativeChatToolRunMembers({
  rows,
  renderRow,
  followKey,
  startsAtEnd,
  memoryKey,
  revealRowKey
}: {
  rows: readonly NativeChatToolRunRow[]
  renderRow: (row: NativeChatToolRunRow) => React.ReactNode
  /** How much work the run holds: a reader at the end follows it growing. Opening a detail must not count. */
  followKey: number
  /** A live run opens on what it is doing now; a settled one reads from its top. */
  startsAtEnd: boolean
  /** The run's disclosure key. Windowing unmounts an off-screen row; its box comes back as the reader left it. */
  memoryKey?: string
  /** The edit row a diff reveal targets; its card does the scrolling once drawn. */
  revealRowKey?: string
}): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const { isVisible, findActive } = useContext(NativeChatToolRunWindowContext)
  const runScroll = useContext(NativeChatDisclosureContext)?.runScroll
  const [remembered] = useState(() =>
    memoryKey === undefined ? undefined : runScroll?.get(memoryKey)
  )
  const followsEndRef = useRef(remembered?.followsEnd ?? startsAtEnd)
  // A copy: the restore helpers update the anchor they are given in place.
  const anchorRef = useRef<VirtualizedScrollAnchor>(
    remembered?.anchor && !remembered.followsEnd ? { ...remembered.anchor } : null
  )
  const scrollOffsetRef = useRef(remembered && !remembered.followsEnd ? remembered.top : 0)
  const [marks] = useState(createProgrammaticScrollMarks)
  const [fades, setFades] = useState({ top: false, bottom: false })
  const isVisibleRef = useRef(isVisible)
  isVisibleRef.current = isVisible

  const rowIndexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows])
  const lastRowKeyRef = useRef(rows.at(-1)?.key)
  lastRowKeyRef.current = rows.at(-1)?.key
  // Below the threshold, or while Find searches drawn text, every row is drawn; one keyed tree serves both modes.
  const drawsEveryRow = rows.length < VIRTUALIZED_LIST_MIN_ROWS || findActive
  const pins = useNativeChatToolRunPins({
    rows,
    rowIndexByKey,
    revealRowKey,
    drawsEveryRow,
    scrollerRef
  })

  const detailHeightsRef = useRef(new Map<string, number>())
  const detailRoomRef = useRef(0)
  const writeDetailRoom = useCallback(() => {
    let room = 0
    for (const height of detailHeightsRef.current.values()) {
      room += height
    }
    if (room !== detailRoomRef.current && scrollerRef.current) {
      detailRoomRef.current = room
      // A variable, not state: a detail animating open would re-render every frame.
      scrollerRef.current.style.setProperty('--native-chat-opened-detail', `${room}px`)
    }
  }, [])
  // Follow transaction: armed by new work while the reader is at the end; done once the tail has really been measured.
  const followRef = useRef<{ observedTail: boolean } | null>(null)

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: VIRTUALIZED_LIST_OVERSCAN,
    rangeExtractor: pins.rangeExtractor,
    // A hidden pane has no boxes to measure; keep the last visible sizes.
    useCachedMeasurements: !isVisible,
    // Both attach and resize measurements pass through here, so the cap and follow see every real measurement.
    measureElement: (element, entry, instance) => {
      const size = measureElement(element, entry, instance)
      const key = element.getAttribute(ROW_KEY_ATTRIBUTE)
      if (key !== null && isVisibleRef.current) {
        const opened = openedDetailHeight(element)
        if (opened > 0) {
          detailHeightsRef.current.set(key, opened)
        } else {
          detailHeightsRef.current.delete(key)
        }
        writeDetailRoom()
        if (followRef.current && key === lastRowKeyRef.current) {
          followRef.current.observedTail = true
        }
      }
      return size
    },
    // Mark every write the virtualizer makes so the reader's own scrolling stays distinguishable.
    scrollToFn: (offset, options, instance) => {
      const element = instance.scrollElement
      const previous = element?.scrollTop
      elementScroll(offset, options, instance)
      if (element && element.scrollTop !== previous) {
        marks.mark(element.scrollTop)
      }
    }
  })

  useVirtualizedScrollAnchor({
    anchorRef,
    getItemElementKey: (element: HTMLDivElement) => element.getAttribute(ROW_KEY_ATTRIBUTE),
    getRowKey: (row: NativeChatToolRunRow) => row.key,
    itemElementSelector: `[${ROW_KEY_ATTRIBUTE}]`,
    programmaticScrollMarks: marks,
    rowIndexByKey,
    rows,
    scrollElementRef: scrollerRef,
    scrollOffsetRef,
    // A following reader belongs to the end, not to a row.
    shouldSkipRestore: () => followsEndRef.current,
    totalSize: virtualizer.getTotalSize(),
    virtualizer
  })

  const pinToEnd = useCallback(() => {
    const scroller = scrollerRef.current
    if (scroller && scroller.scrollTop !== scroller.scrollHeight) {
      marks.mark(scroller.scrollHeight)
      scroller.scrollTop = scroller.scrollHeight
    }
  }, [marks])

  // Before paint: follow only if the reader was at the end before the new work.
  useLayoutEffect(() => {
    if (!followsEndRef.current) {
      return
    }
    followRef.current = { observedTail: false }
    const tail = lastRowKeyRef.current
    const tailElement = Array.from(
      scrollerRef.current?.querySelectorAll<HTMLDivElement>(`[${ROW_KEY_ATTRIBUTE}]`) ?? []
    ).findLast((element) => element.getAttribute(ROW_KEY_ATTRIBUTE) === tail)
    if (tailElement) {
      // One real measurement now, so work that grew no row (a result) still completes the transaction.
      const height = tailElement.getBoundingClientRect().height
      if (height > 0) {
        virtualizer.resizeItem(Number(tailElement.dataset.index), height)
      }
      followRef.current.observedTail = true
    }
    pinToEnd()
  }, [followKey, pinToEnd, virtualizer])

  const totalSize = virtualizer.getTotalSize()
  useLayoutEffect(() => {
    const follow = followRef.current
    if (!follow) {
      return
    }
    pinToEnd()
    if (!follow.observedTail) {
      return
    }
    // Done after one frame with no further tail growth; later detail growth then never scrolls.
    const frame = window.requestAnimationFrame(() => {
      if (followRef.current === follow && virtualizer.getTotalSize() === totalSize) {
        followRef.current = null
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [pinToEnd, totalSize, virtualizer])

  // A reveal owns the box until the reader moves; it never follows.
  useEffect(() => {
    if (revealRowKey !== undefined) {
      followRef.current = null
      followsEndRef.current = false
    }
  }, [revealRowKey])

  // Retired rows give back their detail room.
  useEffect(() => {
    for (const key of detailHeightsRef.current.keys()) {
      if (!rowIndexByKey.has(key)) {
        detailHeightsRef.current.delete(key)
      }
    }
    writeDetailRoom()
  }, [rowIndexByKey, writeDetailRoom])

  const remember = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !runScroll || memoryKey === undefined) {
      return
    }
    const anchor = anchorRef.current
    setWithLRU(
      runScroll,
      memoryKey,
      {
        anchor: anchor ? { ...anchor } : null,
        top: scroller.scrollTop,
        followsEnd: followsEndRef.current
      },
      MAX_NATIVE_CHAT_DISCLOSURES
    )
  }, [memoryKey, runScroll])

  const readPosition = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      return
    }
    const fromEnd = distanceFromBottom(scroller)
    followsEndRef.current = fromEnd <= NATIVE_CHAT_FOLLOW_REARM_PX
    const top = scroller.scrollTop > 1
    const bottom = fromEnd > 1
    setFades((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom }
    )
    remember()
  }, [remember])

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const scroller = event.currentTarget
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      if (!marks.consume(event.nativeEvent, scroller.scrollTop, maxScroll)) {
        // The reader moved: any follow in flight yields to them.
        followRef.current = null
      }
      readPosition()
    },
    [marks, readPosition]
  )

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') {
      return
    }
    // The box's cap moves with an opened detail, which changes what lies past its edges.
    const observer = new ResizeObserver(readPosition)
    observer.observe(scroller)
    if (scroller.firstElementChild) {
      observer.observe(scroller.firstElementChild)
    }
    return () => observer.disconnect()
  }, [readPosition])

  // Declared after the anchor hook, so its cleanup has already recorded the leaving anchor.
  useLayoutEffect(() => remember, [remember])

  const { retainInteractedRow } = pins
  const onReaderAct = useCallback(
    (event: React.SyntheticEvent) => {
      // Opening a detail is the reader acting, not new work: it ends any follow in flight.
      followRef.current = null
      retainInteractedRow(event)
    },
    [retainInteractedRow]
  )

  // Drawn indexes: every row, the virtual window, or (hidden pane, nothing measurable) what was drawn last.
  const drawnRef = useRef<readonly number[]>([])
  const virtualItems = virtualizer.getVirtualItems()
  const drawn = drawsEveryRow
    ? rows.map((_, index) => index)
    : virtualItems.length > 0
      ? virtualItems.map((item) => item.index)
      : drawnRef.current.filter((index) => index < rows.length)
  useLayoutEffect(() => {
    drawnRef.current = drawn
  })
  const measurements = virtualizer.measurementsCache
  const children: React.ReactNode[] = []
  let previousEnd = 0
  for (const index of drawn) {
    const row = rows[index]
    if (!row) {
      continue
    }
    const start = measurements[index]?.start ?? previousEnd
    children.push(
      <Fragment key={row.key}>
        {start > previousEnd + 0.5 ? (
          <div aria-hidden style={{ height: start - previousEnd }} />
        ) : null}
        <div
          ref={virtualizer.measureElement}
          data-index={index}
          data-native-chat-tool-run-row={row.key}
        >
          {renderRow(row)}
        </div>
      </Fragment>
    )
    previousEnd = measurements[index]?.end ?? start
  }
  const trailing = drawsEveryRow ? 0 : totalSize - previousEnd

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className={cn(
        'scrollbar-sleek ml-1.75 mt-0.5 overflow-y-auto border-l border-chat-code-border pl-3.25 [overflow-anchor:none]',
        // Contains the members' absolute sr-only labels, which otherwise lengthen the page.
        'relative',
        // Room for the list plus what the reader has opened in it, up to half the window.
        'max-h-[min(50dvh,calc(18rem+var(--native-chat-opened-detail,0px)))]',
        fades.top && 'mask-t-from-[calc(100%-1.5rem)]',
        fades.bottom && 'mask-b-from-[calc(100%-1.5rem)]'
      )}
      data-native-chat-tool-run-members
    >
      <div
        onClickCapture={onReaderAct}
        onKeyDownCapture={onReaderAct}
        onFocusCapture={pins.onFocusCapture}
        onBlurCapture={pins.onBlurCapture}
      >
        {children}
        {trailing > 0.5 ? <div aria-hidden style={{ height: trailing }} /> : null}
      </div>
    </div>
  )
}
