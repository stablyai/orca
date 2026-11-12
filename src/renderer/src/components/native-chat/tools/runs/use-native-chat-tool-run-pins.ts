import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  drawsEveryRow,
  scrollerRef
}: {
  rows: readonly NativeChatToolRunRow[]
  rowIndexByKey: ReadonlyMap<string, number>
  revealRowKey: string | undefined
  drawsEveryRow: boolean
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
  rowIndexByKeyRef.current = rowIndexByKey
  const focusableIndexes = useMemo(
    () => rows.flatMap((row, index) => (row.focusable ? [index] : [])),
    [rows]
  )

  // The ends (Tab's way in from either side, the tail), the reveal target, interacted rows and the focused row's next stops.
  const pinned = useMemo(() => {
    const indexes = new Set<number>()
    const add = (index: number | undefined): void => {
      if (index !== undefined && index >= 0) {
        indexes.add(index)
      }
    }
    add(rows.length - 1)
    add(focusableIndexes[0])
    add(focusableIndexes.at(-1))
    for (const key of [revealRowKey, ...interactionKeys]) {
      add(key === undefined ? undefined : rowIndexByKey.get(key))
    }
    const focused = focusedKey === null ? undefined : rowIndexByKey.get(focusedKey)
    if (focused !== undefined) {
      add(focusableIndexes.findLast((index) => index < focused))
      add(focusableIndexes.find((index) => index > focused))
    }
    return indexes
  }, [focusableIndexes, focusedKey, interactionKeys, revealRowKey, rowIndexByKey, rows.length])

  const rangeExtractor = useCallback(
    (range: WindowRange) => {
      if (drawsEveryRow) {
        return Array.from({ length: range.count }, (_, index) => index)
      }
      const indexes = nativeChatTranscriptRange(range, pinned)
      if (!selectionSpan) {
        return indexes
      }
      const spanned = new Set(indexes)
      const last = Math.min(selectionSpan[1], range.count - 1)
      for (let index = selectionSpan[0]; index <= last; index++) {
        spanned.add(index)
      }
      return Array.from(spanned).sort((a, b) => a - b)
    },
    [drawsEveryRow, pinned, selectionSpan]
  )

  // An end outside the run (or on a spacer) reaches the run's matching edge.
  useEffect(() => {
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
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [scrollerRef])

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

  return { rangeExtractor, retainInteractedRow, onFocusCapture, onBlurCapture }
}
