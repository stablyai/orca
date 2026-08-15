import React, { useState } from 'react'
import { Trash } from 'lucide-react'
import type { WorktreeTodo } from '../../../../../shared/worktree-todo-types'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

type TodoRowProps = {
  todo: WorktreeTodo
  onToggle: () => Promise<boolean>
  onSave: (body: string) => Promise<boolean>
  onDelete: () => Promise<void>
}

// Why: completed rows are de-emphasized with a subtle token-derived wash plus
// reduced opacity (mirrors the resolved-review-note pattern) rather than a new
// color value, so the styling tracks the theme.
const COMPLETED_WASH = 'color-mix(in srgb, var(--muted-foreground) 7%, transparent)'

export function TodoRow({ todo, onToggle, onSave, onDelete }: TodoRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(todo.body)
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()
  const completed = todo.completedAt !== undefined

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
        aria-label={translate('auto.components.right.sidebar.todos.TodoRow.toggle', 'Toggle todo')}
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
        disabled={busy}
        onClick={() => void runAction(onDelete)}
        // Why: keep delete discoverable but quiet — revealed on row hover / focus.
        // Gate the hide behind `can-hover:` so touch (hover: none) devices keep
        // the button visible instead of stranding it at opacity-0.
        className="shrink-0 text-muted-foreground transition-opacity hover:text-destructive focus-visible:opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100"
        aria-label={translate('auto.components.right.sidebar.todos.TodoRow.delete', 'Delete todo')}
        title={translate('auto.components.right.sidebar.todos.TodoRow.delete', 'Delete todo')}
      >
        <Trash className="size-3" />
      </Button>
    </div>
  )
}
