import type { WorktreeTodo, WorktreeTodoAuthorRole, WorktreeTodoScope } from './types'

// Why: the renderer slice (store/slices/todo-persistence.ts) owns the optimistic
// UI path; these are the same pure list transforms expressed without zustand so
// the main-process agent entry points (orca CLI / RPC) can mutate todos through
// the runtime Store mutators instead of the renderer. Pure and id-free so they
// stay deterministic and unit-testable — the caller supplies id + timestamp.

export type CreateTodoInput = {
  id: string
  scope: WorktreeTodoScope
  /** Owning worktree id (scope 'worktree') or repo id (scope 'project'). */
  ownerId: string
  body: string
  authorRole: WorktreeTodoAuthorRole
  now: number
}

export function normalizeTodoEntry(todo: WorktreeTodo): WorktreeTodo {
  const scope: WorktreeTodoScope = todo.scope === 'project' ? 'project' : 'worktree'
  const authorRole: WorktreeTodoAuthorRole = todo.authorRole === 'agent' ? 'agent' : 'user'
  const rawOrder = (todo as { order?: unknown }).order
  const order = typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : 0
  const rawCompletedAt = (todo as { completedAt?: unknown }).completedAt
  const completedAt =
    typeof rawCompletedAt === 'number' && Number.isFinite(rawCompletedAt) && rawCompletedAt > 0
      ? rawCompletedAt
      : undefined
  const rawUpdatedAt = (todo as { updatedAt?: unknown }).updatedAt
  const updatedAt =
    typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
      ? rawUpdatedAt
      : undefined
  // Why: assign completedAt/updatedAt unconditionally (even to undefined) so a
  // junk value carried by the spread is overwritten, not preserved.
  return {
    ...todo,
    scope,
    authorRole,
    order,
    completedAt,
    updatedAt
  }
}

export function nextTodoOrder(existing: readonly WorktreeTodo[]): number {
  return existing.reduce((max, todo) => Math.max(max, todo.order), -1) + 1
}

export function createTodo(input: CreateTodoInput): WorktreeTodo {
  return normalizeTodoEntry({
    id: input.id,
    scope: input.scope,
    ...(input.scope === 'worktree' ? { worktreeId: input.ownerId } : { repoId: input.ownerId }),
    body: input.body,
    order: 0,
    authorRole: input.authorRole,
    createdAt: input.now
  })
}

export function appendTodo(existing: readonly WorktreeTodo[], todo: WorktreeTodo): WorktreeTodo[] {
  return [...existing, { ...todo, order: nextTodoOrder(existing) }]
}

// Why: each mutator returns null when the id is missing or the change is a no-op
// so callers can surface "not found" / "unchanged" without an extra disk write.
export function updateTodoBody(
  existing: readonly WorktreeTodo[],
  id: string,
  body: string,
  now: number
): WorktreeTodo[] | null {
  const idx = existing.findIndex((t) => t.id === id)
  if (idx === -1 || existing[idx].body === body) {
    return null
  }
  const next = existing.slice()
  next[idx] = { ...existing[idx], body, updatedAt: now }
  return next
}

export function setTodoCompletion(
  existing: readonly WorktreeTodo[],
  id: string,
  completed: boolean,
  now: number
): WorktreeTodo[] | null {
  const idx = existing.findIndex((t) => t.id === id)
  if (idx === -1) {
    return null
  }
  const todo = existing[idx]
  const isCompleted = typeof todo.completedAt === 'number'
  if (isCompleted === completed) {
    return null
  }
  const next = existing.slice()
  // Why: completedAt is the single source of truth for done-ness, so re-opening
  // clears the timestamp rather than tracking a separate boolean.
  next[idx] = completed
    ? { ...todo, completedAt: now, updatedAt: now }
    : { ...todo, completedAt: undefined, updatedAt: now }
  return next
}

export function toggleTodoCompletion(
  existing: readonly WorktreeTodo[],
  id: string,
  now: number
): WorktreeTodo[] | null {
  const todo = existing.find((t) => t.id === id)
  if (!todo) {
    return null
  }
  return setTodoCompletion(existing, id, typeof todo.completedAt !== 'number', now)
}

export function removeTodoById(
  existing: readonly WorktreeTodo[],
  id: string
): WorktreeTodo[] | null {
  const next = existing.filter((t) => t.id !== id)
  return next.length === existing.length ? null : next
}

// Why: stable display order — open items before completed, then by manual order,
// then by creation time so concurrent additions render deterministically.
export function sortTodosForDisplay(existing: readonly WorktreeTodo[]): WorktreeTodo[] {
  return existing.slice().sort((a, b) => {
    const aDone = typeof a.completedAt === 'number'
    const bDone = typeof b.completedAt === 'number'
    if (aDone !== bDone) {
      return aDone ? 1 : -1
    }
    if (a.order !== b.order) {
      return a.order - b.order
    }
    return a.createdAt - b.createdAt
  })
}
