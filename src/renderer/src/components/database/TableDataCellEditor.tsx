import React, { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'

// Inline editor for one grid cell. Enter / blur commits the text; Escape cancels;
// the ∅ button commits SQL NULL (kept distinct from an empty string). Mirrors the
// worktree inline-rename commit/cancel keying.
export function TableDataCellEditor({
  initialText,
  onCommit,
  onCancel
}: {
  initialText: string
  onCommit: (value: unknown) => void
  onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState(initialText)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.select()
  }, [])

  return (
    <div className="flex h-full items-center gap-0.5 bg-background px-1 ring-1 ring-ring">
      <input
        ref={ref}
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onCommit(text)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        onBlur={() => onCommit(text)}
        className="h-full w-full min-w-0 bg-transparent font-mono text-xs outline-none"
      />
      <button
        type="button"
        tabIndex={-1}
        title={translate('auto.components.database.TableDataCellEditor.setNull', 'Set NULL')}
        // preventDefault on mousedown keeps the input from blur-committing text
        // first, so the NULL commit wins.
        onMouseDown={(event) => {
          event.preventDefault()
          onCommit(null)
        }}
        className="shrink-0 px-0.5 text-[10px] text-muted-foreground hover:text-foreground"
      >
        ∅
      </button>
    </div>
  )
}
