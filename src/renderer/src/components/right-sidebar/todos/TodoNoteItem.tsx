import React, { useState } from 'react'
import { Trash } from 'lucide-react'
import type { TodoNote } from '../../../../../shared/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { formatPrCommentRelativeTime } from '@/lib/pr-comment-time'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'

type TodoNoteItemProps = {
  note: TodoNote
  onUpdate: (body: string) => Promise<boolean>
  onDelete: () => Promise<void>
}

// Why: agent-authored notes get a subtle primary accent so a reader can tell at
// a glance which entries came from an agent vs. the user — token-based, no hex,
// so it tracks every theme.
const AUTHOR_CHIP = {
  user: 'text-muted-foreground/60',
  agent: 'text-primary/80'
} as const

export function TodoNoteItem({ note, onUpdate, onDelete }: TodoNoteItemProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()

  const cancelEdit = (): void => {
    setEditing(false)
    setDraft(note.body)
  }

  const commitEdit = async (): Promise<void> => {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === note.body) {
      cancelEdit()
      return
    }
    setBusy(true)
    try {
      const ok = await onUpdate(trimmed)
      if (mountedRef.current && ok) {
        setEditing(false)
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  const runDelete = async (): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      await onDelete()
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  const authorLabel =
    note.authorRole === 'agent'
      ? translate('auto.components.right.sidebar.todos.TodoNoteItem.authorAgent', 'agent')
      : translate('auto.components.right.sidebar.todos.TodoNoteItem.authorUser', 'user')

  return (
    <div data-testid="todo-note" className="group/note flex flex-col gap-0.5 py-1">
      <div
        data-testid="todo-note-meta"
        className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
      >
        <span className={cn('font-medium', AUTHOR_CHIP[note.authorRole])}>{authorLabel}</span>
        <span className="tabular-nums normal-case text-muted-foreground/70">
          {formatPrCommentRelativeTime(new Date(note.createdAt).toISOString(), Date.now())}
        </span>
        {note.updatedAt !== undefined && (
          <span className="normal-case text-muted-foreground/50">
            {translate('auto.components.right.sidebar.todos.TodoNoteItem.edited', 'edited')}
          </span>
        )}
      </div>
      <div className="flex items-start gap-1">
        {editing ? (
          <input
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitEdit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void commitEdit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelEdit()
              }
            }}
            className="min-w-0 flex-1 rounded-sm border border-input bg-transparent px-1 py-0.5 text-[12px] leading-snug outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(note.body)
              setEditing(true)
            }}
            // Why: click-to-edit; the body renders light markdown (links etc.) and
            // links stopPropagation inside CommentMarkdown so they open in place.
            className="min-w-0 flex-1 cursor-text break-words px-1 py-0.5 text-left text-[12px] leading-snug text-foreground/90"
          >
            <CommentMarkdown variant="compact" content={note.body} />
          </button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          onClick={() => void runDelete()}
          // Why: can-hover keeps the control out of the way on desktop but always
          // visible on touch devices, which have no hover state.
          className="shrink-0 text-muted-foreground transition-opacity hover:text-destructive can-hover:opacity-0 focus-visible:opacity-100 group-hover/note:opacity-100"
          aria-label={translate(
            'auto.components.right.sidebar.todos.TodoNoteItem.delete',
            'Delete note'
          )}
          title={translate(
            'auto.components.right.sidebar.todos.TodoNoteItem.delete',
            'Delete note'
          )}
        >
          <Trash className="size-3" />
        </Button>
      </div>
    </div>
  )
}
