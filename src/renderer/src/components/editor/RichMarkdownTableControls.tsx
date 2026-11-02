import React, { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
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
import { useRichMarkdownTableContextMenu } from './use-rich-markdown-table-context-menu'
import {
  useRichMarkdownTableControlTarget,
  type TableAxis
} from './use-rich-markdown-table-control-target'
import {
  richMarkdownTableCellPositionAtElement,
  runRichMarkdownTableAction,
  type RichMarkdownTableAction
} from './rich-markdown-table-actions'

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
  axis,
  className,
  icon,
  label,
  onClick,
  style
}: {
  axis: 'column' | 'row'
  className: string
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
          className={`rich-markdown-table-control ${className}`}
          style={style}
          aria-label={label}
          onClick={onClick}
          data-axis={axis}
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
  onOpenChange,
  style
}: {
  axis: 'column' | 'row'
  cellPosition: number
  editor: Editor
  isHeader: boolean
  onOpenChange: (open: boolean) => void
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
    <DropdownMenu onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="rich-markdown-table-axis-control rich-markdown-table-control"
              style={style}
              aria-label={label}
              data-axis={axis}
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
  const { active, hoveredAddAxis, hoveredAxis } = useRichMarkdownTableControlTarget(
    editor,
    scrollContainerRef
  )
  const [openAxis, setOpenAxis] = useState<TableAxis | null>(null)
  useRichMarkdownTableContextMenu(editor)

  useEffect(() => {
    if (!active || !openAxis || !(active.cell.parentElement instanceof HTMLTableRowElement)) {
      return
    }
    const cells =
      openAxis === 'row'
        ? Array.from(active.cell.parentElement.cells)
        : Array.from(active.table.rows, (tableRow) =>
            tableRow.cells.item(active.cell.cellIndex)
          ).filter((cell): cell is HTMLTableCellElement => cell !== null)
    cells.forEach((cell) => cell.classList.add('rich-markdown-table-control-active'))
    return () =>
      cells.forEach((cell) => cell.classList.remove('rich-markdown-table-control-active'))
  }, [active, openAxis])

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
  const tableRect = contentRect(active.table, scrollContainer)
  const layout = getRichMarkdownTableControlLayout({
    cell: contentRect(active.cell, scrollContainer),
    container: scrollContainer,
    row: contentRect(row, scrollContainer),
    table: tableRect
  })
  const style = (point: { left: number; top: number }): React.CSSProperties => ({
    left: point.left,
    top: point.top
  })
  const viewportRight = scrollContainer.scrollLeft + scrollContainer.clientWidth - 4
  const viewportBottom = scrollContainer.scrollTop + scrollContainer.clientHeight - 4
  const visibleTableWidth = Math.max(
    0,
    Math.min(tableRect.right, viewportRight) -
      Math.max(tableRect.left, scrollContainer.scrollLeft + 4)
  )
  const visibleTableHeight = Math.max(
    0,
    Math.min(tableRect.bottom, viewportBottom) -
      Math.max(tableRect.top, scrollContainer.scrollTop + 4)
  )
  return (
    <div
      className="rich-markdown-table-controls"
      role="group"
      aria-label={translate(
        'auto.components.editor.RichMarkdownTableControls.tableActions',
        'Table actions'
      )}
    >
      {hoveredAxis === 'row' ? (
        <TableActionMenu
          axis="row"
          cellPosition={cellPosition}
          editor={editor}
          isHeader={active.cell.tagName === 'TH'}
          onOpenChange={(open) => setOpenAxis(open ? 'row' : null)}
          style={style(layout.rowMenu)}
        />
      ) : null}
      {hoveredAxis === 'column' ? (
        <TableActionMenu
          axis="column"
          cellPosition={cellPosition}
          editor={editor}
          isHeader={false}
          onOpenChange={(open) => setOpenAxis(open ? 'column' : null)}
          style={style(layout.columnMenu)}
        />
      ) : null}
      {hoveredAddAxis === 'column' && addColumnPosition !== null ? (
        <TableControlButton
          axis="column"
          className="rich-markdown-table-add-control"
          icon={<Plus />}
          label={translate(
            'auto.components.editor.RichMarkdownTableControls.addColumn',
            'Add column'
          )}
          style={{ ...style(layout.addColumn), height: visibleTableHeight }}
          onClick={() =>
            runRichMarkdownTableAction(editor, 'insert-column-right', {
              cellPosition: addColumnPosition
            })
          }
        />
      ) : null}
      {hoveredAddAxis === 'row' && addRowPosition !== null ? (
        <TableControlButton
          axis="row"
          className="rich-markdown-table-add-control"
          icon={<Plus />}
          label={translate('auto.components.editor.RichMarkdownTableControls.addRow', 'Add row')}
          style={{ ...style(layout.addRow), width: visibleTableWidth }}
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
