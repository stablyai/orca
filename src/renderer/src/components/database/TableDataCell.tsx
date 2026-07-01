import React, { useState } from 'react'
import { copyCell, formatCell } from './data-grid-cell-format'
import { TableDataCellEditor } from './TableDataCellEditor'

// Dirty wash uses a color-mix of the annotation-highlight token (no new hex,
// adapts to light/dark) per the styleguide.
const DIRTY_STYLE: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--annotation-highlight) 24%, transparent)'
}

// One data cell. Editable cells enter an inline editor on double-click; read-only
// cells copy on click. NULL renders distinct from an empty string.
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

  if (editing && editable) {
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
    <button
      type="button"
      onDoubleClick={editable ? () => setEditing(true) : undefined}
      onClick={editable ? undefined : () => copyCell(value)}
      title={text}
      style={dirty ? DIRTY_STYLE : undefined}
      className={`h-full truncate border-r border-border/40 px-2 text-left ${
        isNull ? 'italic text-muted-foreground/60' : ''
      }`}
    >
      {text}
    </button>
  )
}
