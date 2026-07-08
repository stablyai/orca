import React, { useState } from 'react'
import { SendHorizontal } from 'lucide-react'
import type { TodoNote } from '../../../../../shared/types'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { TodoNoteItem } from './TodoNoteItem'

type TodoNotesSectionProps = {
  notes: TodoNote[]
  onAddNote: (body: string) => Promise<TodoNote | null>
  onUpdateNote: (noteId: string, body: string) => Promise<boolean>
  onDeleteNote: (noteId: string) => Promise<void>
}

export function TodoNotesSection({
  notes,
  onAddNote,
  onUpdateNote,
  onDeleteNote
}: TodoNotesSectionProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()

  const submit = async (): Promise<void> => {
    const trimmed = value.trim()
    if (!trimmed || busy) {
      return
    }
    // Why: bind disabled immediately so latency on the persist round-trip can't
    // append the same note twice before the optimistic add lands (SSH/runtime).
    setBusy(true)
    try {
      const created = await onAddNote(trimmed)
      if (mountedRef.current && created) {
        setValue('')
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div className="flex flex-col gap-0.5">
      {notes.map((note) => (
        <TodoNoteItem
          key={note.id}
          note={note}
          onUpdate={(body) => onUpdateNote(note.id, body)}
          onDelete={() => onDeleteNote(note.id)}
        />
      ))}
      <div className="mt-1 flex items-center gap-1">
        <input
          data-testid="todo-note-add"
          value={value}
          disabled={busy}
          placeholder={translate(
            'auto.components.right.sidebar.todos.TodoNotesSection.addPlaceholder',
            'Add a note…'
          )}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
          className="min-w-0 flex-1 rounded-sm bg-transparent px-1 py-1 text-[12px] leading-snug outline-none placeholder:text-muted-foreground/50 focus-visible:bg-accent/30 disabled:opacity-50"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={busy || value.trim().length === 0}
          onClick={() => void submit()}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.todos.TodoNotesSection.send',
            'Add note'
          )}
          title={translate('auto.components.right.sidebar.todos.TodoNotesSection.send', 'Add note')}
        >
          <SendHorizontal className="size-3" />
        </Button>
      </div>
    </div>
  )
}
