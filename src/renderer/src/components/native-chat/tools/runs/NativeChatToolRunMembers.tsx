import {
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { cn } from '@/lib/class-names'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import { VIRTUALIZED_LIST_MIN_ROWS } from '@/components/virtualized-list'
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
import { useNativeChatToolRunWindow } from './use-native-chat-tool-run-window'
import { useNativeChatToolRunDetailRoom } from './use-native-chat-tool-run-detail-room'

/** Scroll inside the run, then return its box for transcript alignment; member offsets omit internal scroll. */
export function revealNativeChatToolRunMember(member: HTMLElement): HTMLElement {
  const scroller = member.closest<HTMLElement>('[data-native-chat-tool-run-members]')
  if (!scroller) {
    return member
  }
  scroller.scrollTop += member.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  return scroller
}

const rowElementKey = (element: HTMLDivElement): string | null =>
  element.getAttribute(ROW_KEY_ATTRIBUTE)
const rowKey = (row: NativeChatToolRunRow): string => row.key

/** A drawn row re-renders only when its own row or renderer changes, not on every window move. */
const WindowRow = memo(function WindowRow({
  row,
  renderRow
}: {
  row: NativeChatToolRunRow
  renderRow: (row: NativeChatToolRunRow) => React.ReactNode
}): React.ReactNode {
  return renderRow(row)
})

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
  const restoresRow = remembered !== undefined && !remembered.followsEnd
  const followsEndRef = useRef(remembered?.followsEnd ?? startsAtEnd)
  // A copy: the restore helpers update the anchor they are given in place.
  const anchorRef = useRef<VirtualizedScrollAnchor>(
    restoresRow && remembered.anchor ? { ...remembered.anchor } : null
  )
  const scrollOffsetRef = useRef(restoresRow ? remembered.top : 0)
  // Drawn until the reader moves, so the restore lands on the real row rather than an estimate.
  const [heldRowKey, setHeldRowKey] = useState(() =>
    restoresRow ? remembered.anchor?.key : undefined
  )
  const [marks] = useState(createProgrammaticScrollMarks)
  const [fades, setFades] = useState({ top: false, bottom: false })
  const isVisibleRef = useRef(isVisible)
  const lastRowKeyRef = useRef(rows.at(-1)?.key)
  useLayoutEffect(() => {
    isVisibleRef.current = isVisible
    lastRowKeyRef.current = rows.at(-1)?.key
  })

  const rowIndexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows])
  // Below the threshold, or while Find searches drawn text, every row is drawn; one keyed tree serves both modes.
  const drawsEveryRow = rows.length < VIRTUALIZED_LIST_MIN_ROWS || findActive
  const pins = useNativeChatToolRunPins({
    rows,
    rowIndexByKey,
    revealRowKey,
    heldRowKey,
    drawsEveryRow,
    isVisible,
    scrollerRef
  })
  const detailRoom = useNativeChatToolRunDetailRoom({
    scrollerRef,
    rowIndexByKey,
    initial: remembered?.detailHeights
  })
  // Follow transaction: armed by new work while the reader is at the end; done once the tail has really been measured.
  const followRef = useRef<{ observedTail: boolean } | null>(null)
  const onMeasure = useCallback(
    (element: HTMLDivElement) => {
      const key = element.getAttribute(ROW_KEY_ATTRIBUTE)
      if (key === null || !isVisibleRef.current) {
        return
      }
      detailRoom.record(key, element)
      if (followRef.current && key === lastRowKeyRef.current) {
        followRef.current.observedTail = true
      }
    },
    [detailRoom]
  )
  const { virtualizer, measureRow, totalSize, drawn } = useNativeChatToolRunWindow({
    rows,
    scrollerRef,
    isVisible,
    drawsEveryRow,
    rangeExtractor: pins.rangeExtractor,
    marks,
    onMeasure
  })

  // A following reader belongs to the end, not to a row.
  const shouldSkipRestore = useCallback(() => followsEndRef.current, [])
  useVirtualizedScrollAnchor({
    anchorRef,
    getItemElementKey: rowElementKey,
    getRowKey: rowKey,
    itemElementSelector: `[${ROW_KEY_ATTRIBUTE}]`,
    programmaticScrollMarks: marks,
    rowIndexByKey,
    rows,
    scrollElementRef: scrollerRef,
    scrollOffsetRef,
    shouldSkipRestore,
    // Restore only when rows arrive or the pane shows again: measurement churn is the virtualizer's
    // own, and a reveal or the reader's scrolling must not be pulled back to an older row.
    restoreSignal: `${rows.length}:${isVisible}`,
    totalSize,
    virtualizer
  })

  const pinToEnd = useCallback(() => {
    const scroller = scrollerRef.current
    if (scroller && scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 1) {
      marks.mark(scroller.scrollHeight)
      scroller.scrollTop = scroller.scrollHeight
    }
  }, [marks])

  // Before paint: new work starts a follow only if the reader was at the end before it; each pass
  // re-pins, and one frame without tail growth after the tail's real measurement ends it.
  const followKeyRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (followKeyRef.current !== followKey) {
      followKeyRef.current = followKey
      if (followsEndRef.current) {
        followRef.current = { observedTail: false }
        const tail = lastRowKeyRef.current
        const tailElement = Array.from(
          scrollerRef.current?.querySelectorAll<HTMLDivElement>(`[${ROW_KEY_ATTRIBUTE}]`) ?? []
        ).findLast((element) => element.getAttribute(ROW_KEY_ATTRIBUTE) === tail)
        if (tailElement) {
          // The default measurement returns a cached size without a resize; read the tail itself.
          const height = tailElement.getBoundingClientRect().height
          if (height > 0) {
            virtualizer.resizeItem(Number(tailElement.dataset.index), height)
          }
          followRef.current.observedTail = true
        }
      }
    }
    const follow = followRef.current
    if (!follow) {
      return
    }
    pinToEnd()
    if (!follow.observedTail) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      if (followRef.current === follow && virtualizer.getTotalSize() === totalSize) {
        followRef.current = null
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [followKey, pinToEnd, totalSize, virtualizer])

  // A reveal owns the box until the reader moves; it never follows.
  useLayoutEffect(() => {
    if (revealRowKey !== undefined) {
      followRef.current = null
      followsEndRef.current = false
    }
  }, [revealRowKey])

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
        followsEnd: followsEndRef.current,
        detailHeights: detailRoom.snapshot()
      },
      MAX_NATIVE_CHAT_DISCLOSURES
    )
  }, [detailRoom, memoryKey, runScroll])

  const readPosition = useCallback(() => {
    const scroller = scrollerRef.current
    // A hidden pane reads zero geometry, which is not where the reader is.
    if (!scroller || !isVisibleRef.current) {
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
        // The reader moved: any follow in flight and any held restore row yield to them.
        followRef.current = null
        setHeldRowKey(undefined)
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

  const children: React.ReactNode[] = []
  let previousEnd = 0
  for (const { index, start, end } of drawn) {
    const row = rows[index]
    if (!row) {
      continue
    }
    children.push(
      <Fragment key={row.key}>
        {start > previousEnd + 0.5 ? (
          <div aria-hidden style={{ height: start - previousEnd }} />
        ) : null}
        <div ref={measureRow} data-index={index} data-native-chat-tool-run-row={row.key}>
          <WindowRow row={row} renderRow={renderRow} />
        </div>
      </Fragment>
    )
    previousEnd = Math.max(previousEnd, end)
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
