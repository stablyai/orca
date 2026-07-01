import React, { useState } from 'react'
import { formatCell } from './data-grid-cell-format'
import { TableDataCellEditor } from './TableDataCellEditor'

// Dirty wash uses a color-mix of the annotation-highlight token (no new hex,
// adapts to light/dark) per the styleguide.
const DIRTY_STYLE: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--annotation-highlight) 24%, transparent)'
}

// One data cell. Editable primitives and Dates enter an inline editor on
// double-click. Binary/array/JSON values are read-only — they have no safe
// text round-trip; editing would commit a lossy display string (e.g. "[3 bytes]")
// as the new cell value. Cells are natively text-selectable (no click-to-copy).
export function TableDataCell({
  value,
  dirty,
  editable,
  onCommit
}: {
  value: unknown
  dirty: boolean
  editable: boolean
  onCommit: (value: unknown) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const { text, isNull } = formatCell(value)

  // Binary/array/JSON values have no safe text round-trip; blocking the inline
  // editor prevents their lossy display form from being staged as the new value.
  const isObjectValue = value !== null && typeof value === 'object' && !(value instanceof Date)
  const cellEditable = editable && !isObjectValue

  if (editing && cellEditable) {
    return (
      <div className="h-full min-w-0 border-r border-border/40">
        <TableDataCellEditor
          initialText={isNull ? '' : text}
          onCommit={(next) => {
            onCommit(next)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  return (
    <div
      onDoubleClick={cellEditable ? () => setEditing(true) : undefined}
      title={text}
      style={dirty ? DIRTY_STYLE : undefined}
      className={`h-full truncate border-r border-border/40 px-2 select-text cursor-text ${
        isNull ? 'italic text-muted-foreground/60' : ''
      }`}
    >
      {text}
    </div>
  )
}
