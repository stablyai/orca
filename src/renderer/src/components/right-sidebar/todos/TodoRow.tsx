import React, { useState } from 'react'
import { Maximize2, MessageSquarePlus, StickyNote, Trash } from 'lucide-react'
import type { TodoNote, WorktreeTodo } from '../../../../../shared/types'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { TodoNotesPanel } from './TodoNotesPanel'
import { normalizeNotes } from '@/store/slices/todo-note-normalize'

type TodoRowProps = {
  todo: WorktreeTodo
  onToggle: () => Promise<boolean>
  onSave: (body: string) => Promise<boolean>
  onDelete: () => Promise<void>
  onAddNote: (body: string) => Promise<TodoNote | null>
  onUpdateNote: (noteId: string, body: string) => Promise<boolean>
  onDeleteNote: (noteId: string) => Promise<void>
  onSetNotesDoc: (body: string) => Promise<boolean>
  onOpenFullPage: () => void
}

// Why: completed rows are de-emphasized with a subtle token-derived wash plus
// reduced opacity (mirrors the resolved-review-note pattern) rather than a new
// color value, so the styling tracks the theme.
const COMPLETED_WASH = 'color-mix(in srgb, var(--muted-foreground) 7%, transparent)'

export function TodoRow({
  todo,
  onToggle,
  onSave,
  onDelete,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onSetNotesDoc,
  onOpenFullPage
}: TodoRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(todo.body)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const mountedRef = useMountedRef()
  const completed = todo.completedAt !== undefined
  const notes = normalizeNotes(todo.notes, todo.createdAt)
  const hasDoc = typeof todo.notesDoc === 'string' && todo.notesDoc.trim().length > 0
  // Why: the always-visible note icon appears when the todo has ANY content
  // (a page or at least one update); the hover "add note" hint shows only when
  // there is nothing yet.
  const hasContent = notes.length > 0 || hasDoc

  const startEdit = (): void => {
    setDraft(todo.body)
    setEditing(true)
  }

  const cancelEdit = (): void => {
    setEditing(false)
    setDraft(todo.body)
  }

  const commitEdit = async (): Promise<void> => {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === todo.body) {
      cancelEdit()
      return
    }
    setBusy(true)
    try {
      const ok = await onSave(trimmed)
      if (mountedRef.current && ok) {
        setEditing(false)
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  // Why: bind the disabled state immediately so a slow SSH/runtime round-trip
  // cannot register a second toggle/delete before the first resolves.
  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      await action()
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div className="flex flex-col">
      <div
        data-testid="todo-row"
        className="group flex items-start gap-2 rounded-md px-2 py-1 hover:bg-accent/40"
        style={completed ? { backgroundColor: COMPLETED_WASH } : undefined}
      >
        <Checkbox
          // Why: the shared primitive fills the box with bg-background, which reads as a
          // heavy dark square on the lighter sidebar surface. Make the empty box blend
          // into the panel (transparent + hairline border) so it stays quiet; the checked
          // state keeps the theme's primary token so it adapts across all themes.
          className="mt-0.5 border-border bg-transparent shadow-none transition-colors hover:border-muted-foreground/60"
          checked={completed}
          disabled={busy}
          onCheckedChange={() => void runAction(onToggle)}
          aria-label={translate(
            'auto.components.right.sidebar.todos.TodoRow.toggle',
            'Toggle todo'
          )}
        />
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
            className="min-w-0 flex-1 rounded-sm border border-input bg-transparent px-1 py-0.5 text-[13px] leading-snug outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className={cn(
              'min-w-0 flex-1 cursor-text break-words px-1 py-0.5 text-left text-[13px] leading-snug',
              completed ? 'text-muted-foreground line-through opacity-70' : 'text-foreground'
            )}
          >
            {todo.body}
          </button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="todo-open-page"
          onClick={onOpenFullPage}
          // Why: hover/focus-revealed like delete; opening the full page never
          // mutates so it isn't gated on `busy`. can-hover keeps it on touch.
          className="shrink-0 text-muted-foreground transition-opacity hover:text-foreground can-hover:opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={translate(
            'auto.components.right.sidebar.todos.TodoRow.openPage',
            'Open full page'
          )}
          title={translate(
            'auto.components.right.sidebar.todos.TodoRow.openPage',
            'Open full page'
          )}
        >
          <Maximize2 className="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="todo-notes-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          // Why: with notes the icon is an always-visible affordance (it carries the
          // count); with none it's a quiet add-note hint revealed on hover/focus.
          // can-hover keeps it reachable on touch devices, which have no hover.
          className={cn(
            'shrink-0 gap-0.5 text-muted-foreground transition-opacity hover:text-foreground',
            hasContent
              ? 'opacity-100'
              : 'can-hover:opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
          )}
          aria-label={
            hasContent
              ? translate('auto.components.right.sidebar.todos.TodoRow.notesToggle', 'Toggle notes')
              : translate('auto.components.right.sidebar.todos.TodoRow.addNote', 'Add note')
          }
          title={
            hasContent
              ? translate('auto.components.right.sidebar.todos.TodoRow.notesToggle', 'Toggle notes')
              : translate('auto.components.right.sidebar.todos.TodoRow.addNote', 'Add note')
          }
        >
          {hasContent ? (
            <>
              <StickyNote className="size-3" />
              {notes.length > 0 && (
                <span data-testid="todo-notes-count" className="text-[10px] tabular-nums">
                  {notes.length}
                </span>
              )}
            </>
          ) : (
            <MessageSquarePlus className="size-3" />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          onClick={() => void runAction(onDelete)}
          // Why: keep delete discoverable but quiet — revealed on row hover / focus;
          // can-hover keeps it visible on touch devices.
          className="shrink-0 text-muted-foreground transition-opacity hover:text-destructive can-hover:opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={translate(
            'auto.components.right.sidebar.todos.TodoRow.delete',
            'Delete todo'
          )}
          title={translate('auto.components.right.sidebar.todos.TodoRow.delete', 'Delete todo')}
        >
          <Trash className="size-3" />
        </Button>
      </div>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleContent data-testid="todo-notes" className="collapsible-height-content">
          <TodoNotesPanel
            notesDoc={todo.notesDoc}
            notesDocAuthorRole={todo.notesDocAuthorRole}
            notesDocUpdatedAt={todo.notesDocUpdatedAt}
            notes={notes}
            autoFocusDoc={!hasContent}
            onSetNotesDoc={onSetNotesDoc}
            onAddNote={onAddNote}
            onUpdateNote={onUpdateNote}
            onDeleteNote={onDeleteNote}
            onOpenFullPage={onOpenFullPage}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
