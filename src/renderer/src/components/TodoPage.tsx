import React, { lazy, Suspense, useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { formatPrCommentRelativeTime } from '@/lib/pr-comment-time'
import { normalizeNotes } from '@/store/slices/todo-note-normalize'
import { RichMarkdownErrorBoundary } from '@/components/editor/RichMarkdownErrorBoundary'
import { TodoNotesSection } from '@/components/right-sidebar/todos/TodoNotesSection'

// Why: lazy like EditorContent — RichMarkdownEditor pulls in the heavy TipTap
// bundle, so it only loads when a todo full page is opened.
const RichMarkdownEditor = lazy(() => import('@/components/editor/RichMarkdownEditor'))

// Why: the full-page todo view rendered in the workspace main pane (a sibling of
// the terminal workbench) when activeTabType==='todo'. Reuses the same store
// actions and the inline notes timeline so the two surfaces stay in lockstep.
export default function TodoPage(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const ref = useAppStore((s) =>
    activeWorktreeId ? s.activeTodoByWorktree[activeWorktreeId] : undefined
  )
  const todo = useAppStore((s) => {
    if (!ref) {
      return undefined
    }
    return s.getTodos(ref.scope, ref.ownerId).find((t) => t.id === ref.todoId)
  })
  const closeTodoPage = useAppStore((s) => s.closeTodoPage)
  const updateTodo = useAppStore((s) => s.updateTodo)
  const toggleTodoComplete = useAppStore((s) => s.toggleTodoComplete)
  const setTodoNotesDoc = useAppStore((s) => s.setTodoNotesDoc)
  const addTodoNote = useAppStore((s) => s.addTodoNote)
  const updateTodoNote = useAppStore((s) => s.updateTodoNote)
  const deleteTodoNote = useAppStore((s) => s.deleteTodoNote)

  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()

  // Why: a stale ref (todo deleted, or a 'todo' tab type restored from disk
  // without an in-memory selection) has nothing to show — fall back to the
  // workbench instead of rendering blank.
  useEffect(() => {
    if (!ref || !todo) {
      closeTodoPage()
    }
  }, [ref, todo, closeTodoPage])

  // Why: also guard activeWorktreeId so it narrows to a non-null string for
  // RichMarkdownEditor's required worktreeId prop (a ref only exists when a
  // worktree is active anyway).
  if (!ref || !todo || !activeWorktreeId) {
    return null
  }

  const completed = todo.completedAt !== undefined
  const notesDoc = typeof todo.notesDoc === 'string' ? todo.notesDoc : ''
  const notes = normalizeNotes(todo.notes, todo.createdAt)
  // Why: a stable synthetic file identity so the rich editor scopes its view
  // state / dirty tracking per todo, like a real .md file.
  const pageFileId = `todo:${ref.scope}:${ref.ownerId}:${todo.id}`

  const commitTitle = async (): Promise<void> => {
    const trimmed = titleDraft.trim()
    if (!trimmed || trimmed === todo.body) {
      setTitleEditing(false)
      return
    }
    setBusy(true)
    try {
      const ok = await updateTodo(ref.scope, ref.ownerId, todo.id, trimmed)
      if (mountedRef.current && ok) {
        setTitleEditing(false)
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div
      data-testid="todo-full-page"
      className="flex h-full min-h-0 flex-1 flex-col bg-editor-surface"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="todo-full-page-close"
          onClick={() => closeTodoPage()}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={translate('auto.components.TodoPage.back', 'Back to workspace')}
          title={translate('auto.components.TodoPage.back', 'Back to workspace')}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {translate('auto.components.TodoPage.heading', 'Todo')}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
          {/* Title + complete toggle */}
          <div className="flex items-center gap-3">
            <Checkbox
              className="border-border bg-transparent shadow-none transition-colors hover:border-muted-foreground/60"
              checked={completed}
              disabled={busy}
              onCheckedChange={() => void toggleTodoComplete(ref.scope, ref.ownerId, todo.id)}
              aria-label={translate(
                'auto.components.right.sidebar.todos.TodoRow.toggle',
                'Toggle todo'
              )}
            />
            {titleEditing ? (
              <input
                autoFocus
                value={titleDraft}
                disabled={busy}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void commitTitle()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setTitleEditing(false)
                  }
                }}
                className="min-w-0 flex-1 rounded-sm border border-input bg-transparent px-2 py-1 text-xl font-semibold leading-tight outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/50 disabled:opacity-50"
              />
            ) : (
              <button
                type="button"
                data-testid="todo-full-page-title"
                onClick={() => {
                  setTitleDraft(todo.body)
                  setTitleEditing(true)
                }}
                className={cn(
                  'min-w-0 flex-1 cursor-text break-words px-2 py-1 text-left text-xl font-semibold leading-tight',
                  completed ? 'text-muted-foreground line-through' : 'text-foreground'
                )}
              >
                {todo.body}
              </button>
            )}
          </div>

          {/* Markdown PAGE — Orca's real .md editor (toolbar, blocks, slash menu,
              link bubble). No custom card chrome; the editor owns its surface. */}
          <section className="flex flex-col gap-1">
            <div data-testid="todo-page-doc" className="flex min-h-[480px] flex-col">
              <div className="min-h-0 flex-1">
                {/* Why: mirror EditorContent — the boundary contains a
                    TipTap/ProseMirror render crash to this pane instead of the
                    whole renderer tree. */}
                <RichMarkdownErrorBoundary key={pageFileId} fileId={pageFileId}>
                  <Suspense fallback={null}>
                    <RichMarkdownEditor
                      fileId={pageFileId}
                      content={notesDoc}
                      filePath={`${todo.id}.md`}
                      worktreeId={activeWorktreeId}
                      scrollCacheKey={`todo-page:${todo.id}:rich`}
                      onContentChange={(body) =>
                        void setTodoNotesDoc(ref.scope, ref.ownerId, todo.id, body)
                      }
                      onDirtyStateHint={() => {}}
                      onSave={(body) => void setTodoNotesDoc(ref.scope, ref.ownerId, todo.id, body)}
                    />
                  </Suspense>
                </RichMarkdownErrorBoundary>
              </div>
            </div>
            {todo.notesDocUpdatedAt !== undefined && (
              <span className="px-1 text-[10px] text-muted-foreground/60">
                {translate(
                  'auto.components.right.sidebar.todos.TodoNotesDoc.lastEdited',
                  'edited by {{author}} · {{time}}',
                  {
                    author:
                      todo.notesDocAuthorRole === 'agent'
                        ? translate(
                            'auto.components.right.sidebar.todos.TodoNotesDoc.authorAgent',
                            'agent'
                          )
                        : translate(
                            'auto.components.right.sidebar.todos.TodoNotesDoc.authorUser',
                            'user'
                          ),
                    time: formatPrCommentRelativeTime(
                      new Date(todo.notesDocUpdatedAt).toISOString(),
                      Date.now()
                    )
                  }
                )}
              </span>
            )}
          </section>

          {/* Updates timeline (reused) */}
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {translate('auto.components.right.sidebar.todos.TodoNotesPanel.updates', 'Updates')}
              </span>
              <div className="h-px flex-1 bg-border/50" />
            </div>
            <TodoNotesSection
              notes={notes}
              onAddNote={(body) => addTodoNote(ref.scope, ref.ownerId, todo.id, body)}
              onUpdateNote={(noteId, body) =>
                updateTodoNote(ref.scope, ref.ownerId, todo.id, noteId, body)
              }
              onDeleteNote={(noteId) => deleteTodoNote(ref.scope, ref.ownerId, todo.id, noteId)}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
