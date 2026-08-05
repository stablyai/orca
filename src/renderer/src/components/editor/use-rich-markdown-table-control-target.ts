import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { isInTable, selectionCell } from '@tiptap/pm/tables'

export type ActiveTableCell = { cell: HTMLTableCellElement; table: HTMLTableElement }
export type TableAxis = 'column' | 'row'

type PointerSample = { cell: HTMLTableCellElement; x: number; y: number }

const TABLE_EDGE_HIT_AREA = 8

function tableCellFromTarget(target: EventTarget | null): HTMLTableCellElement | null {
  return target instanceof Element ? target.closest<HTMLTableCellElement>('td, th') : null
}

function selectionTableCell(editor: Editor): HTMLTableCellElement | null {
  // Why: isActive('table') still admits a node selection on the table or a
  // selection merely spanning it, and selectionCell throws for both.
  if (!isInTable(editor.state)) {
    return null
  }
  const node = editor.view.nodeDOM(selectionCell(editor.state).pos)
  return node instanceof HTMLTableCellElement ? node : null
}

function pointerAxes(sample: PointerSample): { add: TableAxis | null; edge: TableAxis | null } {
  const cellRect = sample.cell.getBoundingClientRect()
  const table = sample.cell.closest('table')
  if (!(table instanceof HTMLTableElement)) {
    return { add: null, edge: null }
  }
  const tableRect = table.getBoundingClientRect()
  const edge =
    sample.y - cellRect.top <= TABLE_EDGE_HIT_AREA
      ? 'column'
      : sample.x - cellRect.left <= TABLE_EDGE_HIT_AREA
        ? 'row'
        : null
  const add =
    sample.y >= tableRect.bottom - TABLE_EDGE_HIT_AREA
      ? 'row'
      : sample.x >= tableRect.right - TABLE_EDGE_HIT_AREA
        ? 'column'
        : null
  return { add, edge }
}

export function useRichMarkdownTableControlTarget(
  editor: Editor | null,
  scrollContainerRef: RefObject<HTMLDivElement | null>
): {
  active: ActiveTableCell | null
  hoveredAddAxis: TableAxis | null
  hoveredAxis: TableAxis | null
} {
  const [active, setActive] = useState<ActiveTableCell | null>(null)
  const [hoveredAddAxis, setHoveredAddAxis] = useState<TableAxis | null>(null)
  const [hoveredAxis, setHoveredAxis] = useState<TableAxis | null>(null)
  const [, setLayoutVersion] = useState(0)
  const pendingPointerRef = useRef<PointerSample | null>(null)
  const pointerFrameRef = useRef<number | null>(null)

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!editor || !scrollContainer) {
      return
    }
    const editorDom = editor.view.dom
    const activate = (cell: HTMLTableCellElement | null): void => {
      setActive((current) => {
        if (current?.cell === cell) {
          return current
        }
        const table = cell?.closest('table')
        return cell && table instanceof HTMLTableElement ? { cell, table } : null
      })
    }
    const activateSelection = (): void => {
      pendingPointerRef.current = null
      setHoveredAddAxis(null)
      setHoveredAxis(null)
      activate(selectionTableCell(editor))
    }
    const flushPointer = (): void => {
      pointerFrameRef.current = null
      const sample = pendingPointerRef.current
      pendingPointerRef.current = null
      if (!sample?.cell.isConnected || !editorDom.contains(sample.cell)) {
        return
      }
      const axes = pointerAxes(sample)
      setHoveredAddAxis(axes.add)
      setHoveredAxis(axes.edge)
    }
    const onPointerMove = (event: PointerEvent): void => {
      const cell = tableCellFromTarget(event.target)
      if (cell && editorDom.contains(cell)) {
        activate(cell)
        pendingPointerRef.current = { cell, x: event.clientX, y: event.clientY }
        pointerFrameRef.current ??= window.requestAnimationFrame(flushPointer)
        return
      }
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.rich-markdown-table-controls')
      ) {
        pendingPointerRef.current = null
        activateSelection()
      }
    }
    scrollContainer.addEventListener('pointermove', onPointerMove)
    editor.on('selectionUpdate', activateSelection)
    editor.on('update', activateSelection)
    activateSelection()
    return () => {
      scrollContainer.removeEventListener('pointermove', onPointerMove)
      editor.off('selectionUpdate', activateSelection)
      editor.off('update', activateSelection)
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current)
        // Why: onPointerMove schedules with ??=, so a stale id blocks every
        // later frame once the effect re-runs on a new editor instance.
        pointerFrameRef.current = null
      }
      pendingPointerRef.current = null
    }
  }, [editor, scrollContainerRef])

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    const table = active?.table
    if (!table || !scrollContainer) {
      return
    }
    let layoutFrame: number | null = null
    const update = (): void => {
      layoutFrame ??= window.requestAnimationFrame(() => {
        layoutFrame = null
        setLayoutVersion((version) => version + 1)
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(table)
    observer.observe(scrollContainer)
    scrollContainer.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      scrollContainer.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      if (layoutFrame !== null) {
        window.cancelAnimationFrame(layoutFrame)
      }
    }
  }, [active?.table, scrollContainerRef])

  return { active, hoveredAddAxis, hoveredAxis }
}
