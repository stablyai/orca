import { describe, expect, it } from 'vitest'
import type { WorktreeTodo } from './types'
import {
  appendTodo,
  createTodo,
  normalizeTodoEntry,
  removeTodoById,
  setTodoCompletion,
  sortTodosForDisplay,
  toggleTodoCompletion,
  updateTodoBody
} from './worktree-todo-list'

function todo(overrides: Partial<WorktreeTodo> = {}): WorktreeTodo {
  return {
    id: overrides.id ?? 'todo-1',
    scope: overrides.scope ?? 'worktree',
    worktreeId: overrides.worktreeId ?? 'wt-1',
    body: overrides.body ?? 'Body',
    order: overrides.order ?? 0,
    authorRole: overrides.authorRole ?? 'user',
    createdAt: overrides.createdAt ?? 1,
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {})
  }
}

describe('worktree-todo-list', () => {
  it('createTodo builds a normalized worktree todo with the given author role', () => {
    const created = createTodo({
      id: 'new-1',
      scope: 'worktree',
      ownerId: 'wt-1',
      body: 'Write tests',
      authorRole: 'agent',
      now: 100
    })
    expect(created).toMatchObject({
      id: 'new-1',
      scope: 'worktree',
      worktreeId: 'wt-1',
      body: 'Write tests',
      authorRole: 'agent',
      order: 0,
      createdAt: 100
    })
    expect(created.repoId).toBeUndefined()
  })

  it('createTodo uses repoId for project scope', () => {
    const created = createTodo({
      id: 'new-1',
      scope: 'project',
      ownerId: 'repo-1',
      body: 'Ship',
      authorRole: 'agent',
      now: 100
    })
    expect(created.repoId).toBe('repo-1')
    expect(created.worktreeId).toBeUndefined()
  })

  it('appendTodo assigns the next order key', () => {
    const existing = [todo({ id: 'a', order: 0 }), todo({ id: 'b', order: 4 })]
    const next = appendTodo(existing, todo({ id: 'c', order: 0 }))
    expect(next).toHaveLength(3)
    expect(next[2]).toMatchObject({ id: 'c', order: 5 })
  })

  it('updateTodoBody returns null when missing or unchanged', () => {
    const existing = [todo({ id: 'a', body: 'Same' })]
    expect(updateTodoBody(existing, 'missing', 'X', 5)).toBeNull()
    expect(updateTodoBody(existing, 'a', 'Same', 5)).toBeNull()
    const next = updateTodoBody(existing, 'a', 'New', 5)
    expect(next?.[0]).toMatchObject({ body: 'New', updatedAt: 5 })
  })

  it('setTodoCompletion is idempotent and clears on reopen', () => {
    const open = [todo({ id: 'a' })]
    expect(setTodoCompletion(open, 'a', false, 5)).toBeNull()
    const done = setTodoCompletion(open, 'a', true, 5)
    expect(done?.[0]).toMatchObject({ completedAt: 5, updatedAt: 5 })
    const reopened = setTodoCompletion(done!, 'a', false, 9)
    expect(reopened?.[0].completedAt).toBeUndefined()
    expect(reopened?.[0].updatedAt).toBe(9)
  })

  it('toggleTodoCompletion flips done-ness', () => {
    const open = [todo({ id: 'a' })]
    const done = toggleTodoCompletion(open, 'a', 5)
    expect(done?.[0].completedAt).toBe(5)
    const reopened = toggleTodoCompletion(done!, 'a', 9)
    expect(reopened?.[0].completedAt).toBeUndefined()
  })

  it('removeTodoById returns null when nothing was removed', () => {
    const existing = [todo({ id: 'a' })]
    expect(removeTodoById(existing, 'missing')).toBeNull()
    expect(removeTodoById(existing, 'a')).toEqual([])
  })

  it('normalizeTodoEntry coerces invalid scope/role/order and strips junk timestamps', () => {
    const normalized = normalizeTodoEntry({
      id: 'a',
      scope: 'bogus' as WorktreeTodo['scope'],
      worktreeId: 'wt-1',
      body: 'B',
      order: Number.NaN as unknown as number,
      authorRole: 'hacker' as WorktreeTodo['authorRole'],
      createdAt: 1,
      completedAt: -1,
      updatedAt: 0
    })
    expect(normalized.scope).toBe('worktree')
    expect(normalized.authorRole).toBe('user')
    expect(normalized.order).toBe(0)
    expect(normalized.completedAt).toBeUndefined()
    expect(normalized.updatedAt).toBeUndefined()
  })

  it('sortTodosForDisplay puts open items first, then by order then createdAt', () => {
    const items = [
      todo({ id: 'done', order: 0, completedAt: 5 }),
      todo({ id: 'late', order: 2 }),
      todo({ id: 'early', order: 1 })
    ]
    expect(sortTodosForDisplay(items).map((t) => t.id)).toEqual(['early', 'late', 'done'])
  })
})
