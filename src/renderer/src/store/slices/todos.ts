import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { WorktreeTodo, WorktreeTodoScope } from '../../../../shared/worktree-todo-types'
import {
  EMPTY_TODOS,
  enqueueTodoPersist,
  generateTodoId,
  mutateTodos,
  nextTodoOrder,
  normalizeTodo,
  ownerIdForInput,
  readOwnerTodos,
  rollbackTodos,
  type TodoInput
} from './todo-persistence'

export type { TodoInput } from './todo-persistence'

export type TodosSlice = {
  getTodos: (scope: WorktreeTodoScope, ownerId: string | null | undefined) => WorktreeTodo[]
  addTodo: (input: TodoInput) => Promise<WorktreeTodo | null>
  updateTodo: (
    scope: WorktreeTodoScope,
    ownerId: string,
    todoId: string,
    body: string
  ) => Promise<boolean>
  toggleTodoComplete: (
    scope: WorktreeTodoScope,
    ownerId: string,
    todoId: string,
    completedAt?: number
  ) => Promise<boolean>
  deleteTodo: (scope: WorktreeTodoScope, ownerId: string, todoId: string) => Promise<void>
  reorderTodos: (
    scope: WorktreeTodoScope,
    ownerId: string,
    orderedIds: readonly string[]
  ) => Promise<boolean>
}

export const createTodosSlice: StateCreator<AppState, [], [], TodosSlice> = (set, get) => ({
  getTodos: (scope, ownerId) => {
    // Why: accept null/undefined so callers with an optional active owner can
    // pass it through without allocating a fresh `[]` fallback each render,
    // which would defeat the EMPTY_TODOS sentinel's referential stability.
    if (!ownerId) {
      return EMPTY_TODOS as WorktreeTodo[]
    }
    return readOwnerTodos(get(), scope, ownerId) ?? (EMPTY_TODOS as WorktreeTodo[])
  },

  addTodo: async (input) => {
    const body = input.body.trim()
    if (!body) {
      return null
    }
    const ownerId = ownerIdForInput(input)
    if (!ownerId) {
      return null
    }
    let created: WorktreeTodo | null = null
    const result = mutateTodos(set, input.scope, ownerId, (existing) => {
      const todo = normalizeTodo({
        id: generateTodoId(),
        scope: input.scope,
        ...(input.scope === 'worktree' ? { worktreeId: ownerId } : { repoId: ownerId }),
        body,
        order: nextTodoOrder(existing),
        authorRole: input.authorRole,
        createdAt: Date.now()
      })
      created = todo
      return [...existing, todo]
    })
    if (!result || !created) {
      return null
    }
    try {
      await enqueueTodoPersist(input.scope, ownerId, get)
      return created
    } catch (err) {
      console.error('Failed to persist todos:', err)
      rollbackTodos(set, input.scope, ownerId, result.previous, result.next)
      return null
    }
  },

  updateTodo: async (scope, ownerId, todoId, body) => {
    // Why: trim trailing whitespace but reject an entirely-empty edit so we
    // don't keep a saved item that renders as a blank row. Callers should treat
    // `false` as "edit not committed" and keep the editor open.
    const trimmed = body.trim()
    if (!trimmed) {
      return false
    }
    const existing = readOwnerTodos(get(), scope, ownerId) ?? []
    const existingIdx = existing.findIndex((t) => t.id === todoId)
    if (existingIdx === -1) {
      return false
    }
    if (existing[existingIdx].body === trimmed) {
      return true
    }
    const result = mutateTodos(set, scope, ownerId, (current) => {
      const idx = current.findIndex((t) => t.id === todoId)
      if (idx === -1 || current[idx].body === trimmed) {
        return null
      }
      const next = current.slice()
      next[idx] = { ...current[idx], body: trimmed, updatedAt: Date.now() }
      return next
    })
    if (!result) {
      return true
    }
    try {
      await enqueueTodoPersist(scope, ownerId, get)
      return true
    } catch (err) {
      console.error('Failed to persist todos:', err)
      rollbackTodos(set, scope, ownerId, result.previous, result.next)
      return false
    }
  },

  toggleTodoComplete: async (scope, ownerId, todoId, completedAt = Date.now()) => {
    const result = mutateTodos(set, scope, ownerId, (current) => {
      const idx = current.findIndex((t) => t.id === todoId)
      if (idx === -1) {
        return null
      }
      const next = current.slice()
      const todo = current[idx]
      // Why: toggling clears the timestamp when re-opening so completedAt is the
      // single source of truth for done-ness.
      next[idx] = todo.completedAt
        ? { ...todo, completedAt: undefined, updatedAt: Date.now() }
        : { ...todo, completedAt, updatedAt: Date.now() }
      return next
    })
    if (!result) {
      return false
    }
    try {
      await enqueueTodoPersist(scope, ownerId, get)
      return true
    } catch (err) {
      console.error('Failed to persist todos:', err)
      rollbackTodos(set, scope, ownerId, result.previous, result.next)
      return false
    }
  },

  deleteTodo: async (scope, ownerId, todoId) => {
    const result = mutateTodos(set, scope, ownerId, (existing) => {
      const next = existing.filter((t) => t.id !== todoId)
      return next.length === existing.length ? null : next
    })
    if (!result) {
      return
    }
    try {
      await enqueueTodoPersist(scope, ownerId, get)
    } catch (err) {
      console.error('Failed to persist todos:', err)
      rollbackTodos(set, scope, ownerId, result.previous, result.next)
    }
  },

  reorderTodos: async (scope, ownerId, orderedIds) => {
    const result = mutateTodos(set, scope, ownerId, (existing) => {
      // Why: only reorder when orderedIds is an EXACT permutation of the existing
      // ids — same length, no duplicates, and an identical id-set. A length-only
      // check would accept e.g. ['a','a'] over [a,b], duplicating one item and
      // silently dropping the other. Reject any non-permutation as a no-op (stale
      // id set from a racing add/delete, or a duplicate id).
      if (orderedIds.length !== existing.length) {
        return null
      }
      const existingIds = new Set(existing.map((t) => t.id))
      const seen = new Set<string>()
      for (const id of orderedIds) {
        if (seen.has(id) || !existingIds.has(id)) {
          return null
        }
        seen.add(id)
      }
      const byId = new Map(existing.map((t) => [t.id, t]))
      const next: WorktreeTodo[] = []
      orderedIds.forEach((id, index) => {
        const todo = byId.get(id)
        if (todo) {
          next.push({ ...todo, order: index })
        }
      })
      return next
    })
    if (!result) {
      return false
    }
    try {
      await enqueueTodoPersist(scope, ownerId, get)
      return true
    } catch (err) {
      console.error('Failed to persist todos:', err)
      rollbackTodos(set, scope, ownerId, result.previous, result.next)
      return false
    }
  }
})
