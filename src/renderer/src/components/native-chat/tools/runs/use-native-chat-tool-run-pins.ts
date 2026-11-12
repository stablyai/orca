import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { VIRTUALIZED_LIST_MIN_ROWS } from '@/components/virtualized-list'
import { nativeChatTranscriptRange } from '../../viewport/virtualization/native-chat-pinned-rows'
import type { NativeChatToolRunRow } from './native-chat-tool-run-rows'

export const ROW_KEY_ATTRIBUTE = 'data-native-chat-tool-run-row'
/** Clicked/focused rows stay drawn, so their own scroll and local state survive the reader scrolling away. */
const MAX_INTERACTION_PINS = 24

type WindowRange = { startIndex: number; endIndex: number; overscan: number; count: number }

function rowKeyOf(target: EventTarget | null): string | null {
  const row = target instanceof Element ? target.closest(`[${ROW_KEY_ATTRIBUTE}]`) : null
  return row?.getAttribute(ROW_KEY_ATTRIBUTE) ?? null
}

/** Which rows an opened run draws beyond its window: bounded obligations, never the run's length,
 *  except a selection, which keeps every row between its ends so copying takes all of them. */
export function useNativeChatToolRunPins({
  rows,
  rowIndexByKey,
  revealRowKey,
  heldRowKey,
  drawsEveryRow,
  isVisible,
  scrollerRef
}: {
  rows: readonly NativeChatToolRunRow[]
  rowIndexByKey: ReadonlyMap<string, number>
  revealRowKey: string | undefined
  /** The row a returning reader is being restored to; drawn until they move. */
  heldRowKey: string | undefined
  drawsEveryRow: boolean
  isVisible: boolean
  scrollerRef: React.RefObject<HTMLDivElement | null>
}): {
  rangeExtractor: (range: WindowRange) => number[]
  retainInteractedRow: (event: React.SyntheticEvent) => void
  onFocusCapture: (event: React.FocusEvent) => void
  onBlurCapture: (event: React.FocusEvent) => void
} {
  const [interactionKeys, setInteractionKeys] = useState<readonly string[]>([])
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [selectionSpan, setSelectionSpan] = useState<readonly [number, number] | null>(null)
  const rowIndexByKeyRef = useRef(rowIndexByKey)
  useLayoutEffect(() => {
    rowIndexByKeyRef.current = rowIndexByKey
  }, [rowIndexByKey])
  // Each row's previous and next focusable rows, built once per row list so a focus move is a lookup.
  const focusNeighbors = useMemo(() => {
    const previous = new Int32Array(rows.length).fill(-1)
    const next = new Int32Array(rows.length).fill(-1)
    let last = -1
    for (let index = 0; index < rows.length; index++) {
      previous[index] = last
      if (rows[index]?.focusable) {
        last = index
      }
    }
    last = -1
    for (let index = rows.length - 1; index >= 0; index--) {
      next[index] = last
      if (rows[index]?.focusable) {
        last = index
      }
    }
    const first = rows[0]?.focusable ? 0 : (next[0] ?? -1)
    const final = rows.at(-1)?.focusable ? rows.length - 1 : (previous[rows.length - 1] ?? -1)
    return { previous, next, first, final }
  }, [rows])

  // The ends (Tab's way in from either side, the tail), the reveal target, interacted rows and the focused row's next stops.
  const pinned = useMemo(() => {
    const indexes = new Set<number>()
    const add = (index: number | undefined): void => {
      if (index !== undefined && index >= 0) {
        indexes.add(index)
      }
    }
    add(rows.length - 1)
    add(focusNeighbors.first)
    add(focusNeighbors.final)
    for (const key of [revealRowKey, heldRowKey, ...interactionKeys]) {
      add(key === undefined ? undefined : rowIndexByKey.get(key))
    }
    const focused = focusedKey === null ? undefined : rowIndexByKey.get(focusedKey)
    if (focused !== undefined) {
      add(focusNeighbors.previous[focused])
      add(focusNeighbors.next[focused])
    }
    return indexes
  }, [
    focusNeighbors,
    focusedKey,
    heldRowKey,
    interactionKeys,
    revealRowKey,
    rowIndexByKey,
    rows.length
  ])

  // A hidden run cannot be copied from; a visible one tracks selection even while drawing every row,
  // so the span is already known when it goes back to its window.
  const tracksSelection = isVisible
  // One array per row count: the virtualizer keeps its items while the same array comes back, so
  // scrolling a run that draws every row rebuilds nothing.
  const everyIndex = useMemo(
    () => Array.from({ length: rows.length }, (_, index) => index),
    [rows.length]
  )
  // A selection's rows plus the pins, reused while the window stays inside the selection.
  const span = tracksSelection && !drawsEveryRow ? selectionSpan : null
  const spanned = useMemo(() => {
    if (!span) {
      return null
    }
    const indexes = new Set(pinned)
    for (let index = span[0]; index <= Math.min(span[1], rows.length - 1); index++) {
      indexes.add(index)
    }
    return Array.from(indexes).sort((a, b) => a - b)
  }, [pinned, rows.length, span])
  const rangeExtractor = useCallback(
    (range: WindowRange) => {
      if (drawsEveryRow) {
        return everyIndex
      }
      const first = Math.max(0, range.startIndex - range.overscan)
      const last = Math.min(range.count - 1, range.endIndex + range.overscan)
      if (spanned && span && span[0] <= first && last <= span[1]) {
        return spanned
      }
      const indexes = nativeChatTranscriptRange(range, pinned)
      if (!spanned) {
        return indexes
      }
      return Array.from(new Set([...indexes, ...spanned])).sort((a, b) => a - b)
    },
    [drawsEveryRow, everyIndex, pinned, span, spanned]
  )

  // An end outside the run (or on a spacer) reaches the run's matching edge.
  useEffect(() => {
    if (!tracksSelection) {
      return
    }
    const onSelectionChange = (): void => {
      const scroller = scrollerRef.current
      const selection = document.getSelection()
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      if (!scroller || !range || !range.intersectsNode(scroller)) {
        setSelectionSpan((current) => (current === null ? current : null))
        return
      }
      const indexAt = (node: Node, fallback: number): number => {
        if (!scroller.contains(node)) {
          return fallback
        }
        const key = rowKeyOf(node instanceof Element ? node : node.parentElement)
        return (key === null ? undefined : rowIndexByKeyRef.current.get(key)) ?? fallback
      }
      const start = indexAt(range.startContainer, 0)
      const end = indexAt(range.endContainer, rowIndexByKeyRef.current.size - 1)
      setSelectionSpan((current) =>
        current && current[0] === start && current[1] === end ? current : [start, end]
      )
    }
    // Re-derive on (re)registration: the selection may have changed while this run was hidden.
    onSelectionChange()
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [scrollerRef, tracksSelection])

  const retainInteractedRow = useCallback((event: React.SyntheticEvent) => {
    const key = rowKeyOf(event.target)
    if (key === null) {
      return
    }
    setInteractionKeys((current) =>
      current.at(-1) === key
        ? current
        : [...current.filter((candidate) => candidate !== key), key].slice(-MAX_INTERACTION_PINS)
    )
  }, [])
  const onFocusCapture = useCallback(
    (event: React.FocusEvent) => {
      setFocusedKey(rowKeyOf(event.target))
      retainInteractedRow(event)
    },
    [retainInteractedRow]
  )
  const onBlurCapture = useCallback(
    (event: React.FocusEvent) => {
      const next = event.relatedTarget
      if (!(next instanceof Node) || !scrollerRef.current?.contains(next)) {
        setFocusedKey(null)
      }
    },
    [scrollerRef]
  )

  // A selection wider than a window keeps that many rows drawn while the reader scrolls.
  const spansSelection = span !== null && span[1] - span[0] >= VIRTUALIZED_LIST_MIN_ROWS
  return { rangeExtractor, spansSelection, retainInteractedRow, onFocusCapture, onBlurCapture }
}
