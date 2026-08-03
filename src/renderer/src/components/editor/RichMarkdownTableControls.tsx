import React, { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { selectionCell } from '@tiptap/pm/tables'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns3,
  GripHorizontal,
  GripVertical,
  Plus,
  Rows3,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getRichMarkdownTableControlLayout } from './rich-markdown-table-control-layout'
import {
  richMarkdownTableCellPositionAtElement,
  runRichMarkdownTableAction,
  type RichMarkdownTableAction
} from './rich-markdown-table-actions'

type ActiveTableCell = { cell: HTMLTableCellElement; table: HTMLTableElement }

function tableCellFromTarget(target: EventTarget | null): HTMLTableCellElement | null {
  return target instanceof Element ? target.closest<HTMLTableCellElement>('td, th') : null
}

function selectionTableCell(editor: Editor): HTMLTableCellElement | null {
  if (!editor.isActive('table')) {
    return null
  }
  const node = editor.view.nodeDOM(selectionCell(editor.state).pos)
  return node instanceof HTMLTableCellElement ? node : null
}

function contentRect(element: Element, container: HTMLElement) {
  const elementRect = element.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  return {
    bottom: elementRect.bottom - containerRect.top + container.scrollTop,
    left: elementRect.left - containerRect.left + container.scrollLeft,
    right: elementRect.right - containerRect.left + container.scrollLeft,
    top: elementRect.top - containerRect.top + container.scrollTop
  }
}

function TableControlButton({
  icon,
  label,
  onClick,
  style
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  style: React.CSSProperties
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          className="rich-markdown-table-control"
          style={style}
          aria-label={label}
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function TableActionMenu({
  axis,
  cellPosition,
  editor,
  isHeader,
  style
}: {
  axis: 'column' | 'row'
  cellPosition: number
  editor: Editor
  isHeader: boolean
  style: React.CSSProperties
}): React.JSX.Element {
  const isRow = axis === 'row'
  const label = isRow
    ? translate('auto.components.editor.RichMarkdownTableControls.rowActions', 'Row actions')
    : translate('auto.components.editor.RichMarkdownTableControls.columnActions', 'Column actions')
  const beforeLabel = isRow
    ? translate(
        'auto.components.editor.RichMarkdownTableControls.insertRowAbove',
        'Insert row above'
      )
    : translate(
        'auto.components.editor.RichMarkdownTableControls.insertColumnLeft',
        'Insert column left'
      )
  const afterLabel = isRow
    ? translate(
        'auto.components.editor.RichMarkdownTableControls.insertRowBelow',
        'Insert row below'
      )
    : translate(
        'auto.components.editor.RichMarkdownTableControls.insertColumnRight',
        'Insert column right'
      )
  const deleteLabel = isRow
    ? translate('auto.components.editor.RichMarkdownTableControls.deleteRow', 'Delete row')
    : translate('auto.components.editor.RichMarkdownTableControls.deleteColumn', 'Delete column')
  const run = (action: RichMarkdownTableAction): void => {
    runRichMarkdownTableAction(editor, action, { cellPosition })
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="rich-markdown-table-control"
              style={style}
              aria-label={label}
            >
              {isRow ? <GripVertical /> : <GripHorizontal />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side={isRow ? 'right' : 'bottom'}>
        <DropdownMenuItem
          disabled={isRow && isHeader}
          onSelect={() => run(isRow ? 'insert-row-above' : 'insert-column-left')}
        >
          {isRow ? <ArrowUp /> : <ArrowLeft />}
          {beforeLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run(isRow ? 'insert-row-below' : 'insert-column-right')}>
          {isRow ? <ArrowDown /> : <ArrowRight />}
          {afterLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={isRow && isHeader}
          onSelect={() => run(isRow ? 'delete-row' : 'delete-column')}
        >
          {isRow ? <Rows3 /> : <Columns3 />}
          {deleteLabel}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => run('delete-table')}>
          <Trash2 />
          {translate(
            'auto.components.editor.RichMarkdownTableControls.deleteTable',
            'Delete table'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function RichMarkdownTableControls({
  disabled = false,
  editor,
  scrollContainerRef
}: {
  disabled?: boolean
  editor: Editor | null
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const [active, setActive] = useState<ActiveTableCell | null>(null)
  const [, setLayoutVersion] = useState(0)

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!editor || !scrollContainer) {
      return
    }
    const activate = (cell: HTMLTableCellElement | null): void => {
      const table = cell?.closest('table')
      setActive(cell && table instanceof HTMLTableElement ? { cell, table } : null)
    }
    const activateSelection = (): void => activate(selectionTableCell(editor))
    const onPointerMove = (event: PointerEvent): void => {
      const cell = tableCellFromTarget(event.target)
      if (cell && editor.view.dom.contains(cell)) {
        activate(cell)
        return
      }
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.rich-markdown-table-controls')
      ) {
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
    }
  }, [editor, scrollContainerRef])

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!active || !scrollContainer) {
      return
    }
    const update = (): void => setLayoutVersion((version) => version + 1)
    const observer = new ResizeObserver(update)
    observer.observe(active.table)
    observer.observe(scrollContainer)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [active, scrollContainerRef])

  const scrollContainer = scrollContainerRef.current
  if (
    disabled ||
    !editor ||
    !editor.isEditable ||
    !scrollContainer ||
    !active?.cell.isConnected ||
    !active.table.isConnected
  ) {
    return null
  }
  const row = active.cell.parentElement
  const finalRow = active.table.rows.item(active.table.rows.length - 1)
  const firstRow = active.table.rows.item(0)
  const addRowCell = finalRow?.cells.item(0) ?? null
  const addColumnCell = firstRow?.cells.item(firstRow.cells.length - 1) ?? null
  const cellPosition = richMarkdownTableCellPositionAtElement(editor, active.cell)
  const addRowPosition = addRowCell
    ? richMarkdownTableCellPositionAtElement(editor, addRowCell)
    : null
  const addColumnPosition = addColumnCell
    ? richMarkdownTableCellPositionAtElement(editor, addColumnCell)
    : null
  if (!(row instanceof HTMLTableRowElement) || cellPosition === null) {
    return null
  }
  const layout = getRichMarkdownTableControlLayout({
    cell: contentRect(active.cell, scrollContainer),
    container: scrollContainer,
    row: contentRect(row, scrollContainer),
    table: contentRect(active.table, scrollContainer)
  })
  const style = (point: { left: number; top: number }): React.CSSProperties => ({
    left: point.left,
    top: point.top
  })
  return (
    <div
      className="rich-markdown-table-controls"
      role="group"
      aria-label={translate(
        'auto.components.editor.RichMarkdownTableControls.tableActions',
        'Table actions'
      )}
    >
      <TableActionMenu
        axis="row"
        cellPosition={cellPosition}
        editor={editor}
        isHeader={active.cell.tagName === 'TH'}
        style={style(layout.rowMenu)}
      />
      <TableActionMenu
        axis="column"
        cellPosition={cellPosition}
        editor={editor}
        isHeader={false}
        style={style(layout.columnMenu)}
      />
      {addColumnPosition !== null ? (
        <TableControlButton
          icon={<Plus />}
          label={translate(
            'auto.components.editor.RichMarkdownTableControls.addColumn',
            'Add column'
          )}
          style={style(layout.addColumn)}
          onClick={() =>
            runRichMarkdownTableAction(editor, 'insert-column-right', {
              cellPosition: addColumnPosition
            })
          }
        />
      ) : null}
      {addRowPosition !== null ? (
        <TableControlButton
          icon={<Plus />}
          label={translate('auto.components.editor.RichMarkdownTableControls.addRow', 'Add row')}
          style={style(layout.addRow)}
          onClick={() =>
            runRichMarkdownTableAction(editor, 'insert-row-below', {
              cellPosition: addRowPosition
            })
          }
        />
      ) : null}
    </div>
  )
}
