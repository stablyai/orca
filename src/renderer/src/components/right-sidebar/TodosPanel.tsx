import React, { useState } from 'react'
import { Plus } from 'lucide-react'
import type { WorktreeTodo, WorktreeTodoScope } from '../../../../shared/worktree-todo-types'
import { useAppStore } from '@/store'
import { useActiveWorktree, useActiveWorktreeId, useRepoById } from '@/store/selectors'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { TodoRow } from './todos/TodoRow'

type TodoSectionProps = {
  title: string
  scope: WorktreeTodoScope
  ownerId: string
  todos: WorktreeTodo[]
  emptyLabel: string
  addPlaceholder: string
}

function TodoSection({
  title,
  scope,
  ownerId,
  todos,
  emptyLabel,
  addPlaceholder
}: TodoSectionProps): React.JSX.Element {
  const addTodo = useAppStore((s) => s.addTodo)
  const updateTodo = useAppStore((s) => s.updateTodo)
  const toggleTodoComplete = useAppStore((s) => s.toggleTodoComplete)
  const deleteTodo = useAppStore((s) => s.deleteTodo)

  return (
    <section data-testid={`todo-section-${scope}`} className="flex flex-col gap-1 px-2 py-3">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground/60">{todos.length}</span>
      </div>
      <div className="flex flex-col">
        {todos.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            onToggle={() => toggleTodoComplete(scope, ownerId, todo.id)}
            onSave={(body) => updateTodo(scope, ownerId, todo.id, body)}
            onDelete={() => deleteTodo(scope, ownerId, todo.id)}
          />
        ))}
        {todos.length === 0 && (
          <p className="px-2 py-1 text-[12px] text-muted-foreground/70">{emptyLabel}</p>
        )}
      </div>
      <AddTodoInput
        placeholder={addPlaceholder}
        onAdd={(body) =>
          addTodo({
            scope,
            ...(scope === 'worktree' ? { worktreeId: ownerId } : { repoId: ownerId }),
            body,
            authorRole: 'user'
          })
        }
      />
    </section>
  )
}

type AddTodoInputProps = {
  placeholder: string
  onAdd: (body: string) => Promise<WorktreeTodo | null>
}

function AddTodoInput({ placeholder, onAdd }: AddTodoInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()

  const submit = async (): Promise<void> => {
    const trimmed = value.trim()
    if (!trimmed || busy) {
      return
    }
    // Why: bind disabled immediately so latency on the persist round-trip can't
    // double-submit the same item before the optimistic add lands.
    setBusy(true)
    try {
      const created = await onAdd(trimmed)
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
    <div className="mt-1 flex items-center gap-1 px-1">
      <Plus className="size-3.5 shrink-0 text-muted-foreground/70" />
      <input
        value={value}
        disabled={busy}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        className="min-w-0 flex-1 rounded-sm bg-transparent px-1 py-1 text-[13px] leading-snug outline-none placeholder:text-muted-foreground/50 focus-visible:bg-accent/30 disabled:opacity-50"
      />
    </div>
  )
}

export default function TodosPanel(): React.JSX.Element {
  const activeWorktreeId = useActiveWorktreeId()
  const activeWorktree = useActiveWorktree()
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const worktreeTodos = useAppStore((s) => s.getTodos('worktree', activeWorktreeId))
  const projectTodos = useAppStore((s) => s.getTodos('project', repo?.id ?? null))

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek">
      {activeWorktreeId ? (
        <TodoSection
          title={translate(
            'auto.components.right.sidebar.TodosPanel.worktreeSection',
            'This worktree'
          )}
          scope="worktree"
          ownerId={activeWorktreeId}
          todos={worktreeTodos}
          emptyLabel={translate(
            'auto.components.right.sidebar.TodosPanel.worktreeEmpty',
            'No todos for this worktree yet.'
          )}
          addPlaceholder={translate(
            'auto.components.right.sidebar.TodosPanel.addPlaceholder',
            'Add a todo…'
          )}
        />
      ) : (
        <p className="px-3 py-4 text-[12px] text-muted-foreground/70">
          {translate(
            'auto.components.right.sidebar.TodosPanel.noWorktree',
            'Open a worktree to track todos.'
          )}
        </p>
      )}
      {repo && (
        <>
          <div className="mx-2 border-t border-border" />
          <TodoSection
            title={translate('auto.components.right.sidebar.TodosPanel.projectSection', 'Project')}
            scope="project"
            ownerId={repo.id}
            todos={projectTodos}
            emptyLabel={translate(
              'auto.components.right.sidebar.TodosPanel.projectEmpty',
              'No project todos yet.'
            )}
            addPlaceholder={translate(
              'auto.components.right.sidebar.TodosPanel.addPlaceholder',
              'Add a todo…'
            )}
          />
        </>
      )}
    </div>
  )
}
