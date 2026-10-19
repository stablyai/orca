import { Textarea } from '@/components/ui/textarea'
import { CsvCellValue } from './CsvCellValue'
import { csvCellIsSelected } from './csv-cell-selection'
import type { CsvGridInteraction } from './csv-grid-interaction'
import { translate } from '@/i18n/i18n'

function focusCellInput(node: HTMLTextAreaElement | null): void {
  node?.focus({ preventScroll: true })
}

export function CsvGridCell({
  value,
  row,
  column,
  id,
  header = false,
  interaction,
  onOpenUrl,
  focusGrid,
  children
}: {
  value: string
  row: number
  column: number
  id: string
  header?: boolean
  interaction?: CsvGridInteraction
  onOpenUrl?: (url: string, event: React.MouseEvent<HTMLAnchorElement>) => void
  focusGrid: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const editing = interaction?.editing
  const active = editing?.position.row === row && editing.position.column === column
  return (
    <div
      id={id}
      role={header ? 'columnheader' : interaction ? 'gridcell' : 'cell'}
      aria-colindex={column + 2}
      aria-label={header ? value : undefined}
      aria-selected={
        interaction ? csvCellIsSelected(interaction.selection, row, column) : undefined
      }
      data-active={
        interaction?.selection?.focus.row === row && interaction.selection.focus.column === column
      }
      data-csv-row={row}
      data-csv-column={column}
      className={
        header
          ? 'relative flex min-w-0 items-center border-b border-r border-border/60 font-medium text-foreground aria-selected:bg-accent data-[active=true]:ring-1 data-[active=true]:ring-inset data-[active=true]:ring-ring'
          : 'flex min-w-0 items-center overflow-hidden border-b border-r border-border/40 text-foreground aria-selected:bg-accent data-[active=true]:ring-1 data-[active=true]:ring-inset data-[active=true]:ring-ring'
      }
      title={value}
      onDoubleClick={(event) => {
        if (event.target instanceof Element && event.target.closest('a,[role="separator"]')) {
          return
        }
        interaction?.edit(row, column)
      }}
    >
      {active && editing ? (
        <Textarea
          ref={focusCellInput}
          variant="cell"
          rows={1}
          aria-label={translate('csv.editCell', 'Edit row {{row}}, column {{column}}', {
            row: row + 1,
            column: column + 1
          })}
          value={editing.value}
          onChange={(event) => interaction?.change(event.target.value)}
          onBlur={() => interaction?.commit()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.nativeEvent.isComposing) {
              return
            }
            const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
            if (modifier && event.key.toLowerCase() === 's') {
              event.preventDefault()
              interaction?.save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              interaction?.cancel()
              focusGrid()
            } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
              event.preventDefault()
              if (interaction?.commit()) {
                focusGrid()
              }
            }
          }}
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center px-2">
          {header ? (
            <span className="truncate">{value}</span>
          ) : (
            <CsvCellValue value={value} onOpenUrl={onOpenUrl} />
          )}
        </div>
      )}
      {children}
    </div>
  )
}
