import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Checkbox } from '../ui/checkbox'
import { cn } from '../../lib/utils'

export type OrderedNetworkAddressRowModel = {
  address: string
  label: string
  selected: boolean
  priorityIndex: number | null
  isCustom: boolean
}

type RowChromeProps = {
  row: OrderedNetworkAddressRowModel
  checkboxDisabled: boolean
  onToggle: (address: string, checked: boolean) => void
  dragHandle?: React.ReactNode
  liRef?: (node: HTMLElement | null) => void
  liStyle?: React.CSSProperties
  liClassName?: string
}

function displayLabel(row: OrderedNetworkAddressRowModel): string {
  return row.isCustom
    ? translate(
        'auto.components.mobile.OrderedNetworkAddressPicker.custom-option',
        '{{address}} (custom)',
        { address: row.address }
      )
    : row.label
}

function AddressRowChrome({
  row,
  checkboxDisabled,
  onToggle,
  dragHandle,
  liRef,
  liStyle,
  liClassName
}: RowChromeProps): React.JSX.Element {
  const label = displayLabel(row)
  return (
    <li
      ref={liRef}
      style={liStyle}
      className={cn('flex items-center gap-2 px-2.5 py-1.5 text-sm', liClassName)}
    >
      {/* Why: fixed lead slots keep checkboxes aligned whether the row is selected. */}
      <span className="flex size-6 shrink-0 items-center justify-center">
        {dragHandle ?? <span className="size-6" aria-hidden />}
      </span>
      <span
        className={cn(
          'text-muted-foreground w-4 shrink-0 text-center text-xs tabular-nums',
          !row.selected && 'invisible'
        )}
        aria-hidden={!row.selected}
      >
        {row.priorityIndex ?? '–'}
      </span>
      <Checkbox
        checked={row.selected}
        disabled={checkboxDisabled}
        onCheckedChange={(value) => {
          onToggle(row.address, value === true)
        }}
        aria-label={label}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </li>
  )
}

type SortableProps = {
  row: OrderedNetworkAddressRowModel
  checkboxDisabled: boolean
  dragDisabled: boolean
  onToggle: (address: string, checked: boolean) => void
}

/** Selected advertise row with grip drag handle. */
export function SortableOrderedNetworkAddressRow({
  row,
  checkboxDisabled,
  dragDisabled,
  onToggle
}: SortableProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.address,
    disabled: dragDisabled
  })

  return (
    <AddressRowChrome
      row={row}
      checkboxDisabled={checkboxDisabled}
      onToggle={onToggle}
      liRef={setNodeRef}
      liStyle={{
        transform: CSS.Transform.toString(transform),
        transition
      }}
      liClassName={cn(isDragging && 'bg-muted/40 relative z-10 opacity-90 shadow-sm')}
      dragHandle={
        <button
          type="button"
          className={cn(
            'text-muted-foreground hover:text-foreground -ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm',
            dragDisabled
              ? 'cursor-default opacity-40'
              : 'cursor-grab touch-none active:cursor-grabbing'
          )}
          disabled={dragDisabled}
          aria-label={translate(
            'auto.components.mobile.OrderedNetworkAddressPicker.drag-handle',
            'Drag to reorder {{address}}',
            { address: row.address }
          )}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
      }
    />
  )
}

type StaticProps = {
  row: OrderedNetworkAddressRowModel
  checkboxDisabled: boolean
  onToggle: (address: string, checked: boolean) => void
}

/** Unselected advertise candidate — not part of the sortable list. */
export function StaticOrderedNetworkAddressRow({
  row,
  checkboxDisabled,
  onToggle
}: StaticProps): React.JSX.Element {
  return <AddressRowChrome row={row} checkboxDisabled={checkboxDisabled} onToggle={onToggle} />
}
