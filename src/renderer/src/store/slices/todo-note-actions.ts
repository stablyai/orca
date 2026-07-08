import type { AppState } from '../types'
import type { TodoNote, WorktreeTodoScope } from '../../../../shared/types'
import {
  enqueueTodoPersist,
  mutateTodoNotes,
  mutateTodos,
  rollbackTodos,
  type TodoSet
} from './todo-persistence'
import { generateNoteId } from './todo-note-normalize'

// Why: the per-todo notes actions (updates timeline + markdown page) split out of
// todos.ts to keep that slice file under the max-lines limit. They share the same
// optimistic + per-owner persist-queue + rollback engine as the rest of the slice.
export type TodoNoteActions = {
  addTodoNote: (
    scope: WorktreeTodoScope,
    ownerId: string,
    todoId: string,
    body: string
  ) => Promise<TodoNote | null>
  updateTodoNote: (
    scope: WorktreeTodoScope,
    ownerId: string,
    todoId: string,
    noteId: string,
    body: string
  ) => Promise<boolean>
  deleteTodoNote: (
    scope: WorktreeTodoScope,
    ownerId: string,
    todoId: string,
    noteId: string
  ) => Promise<void>
  setTodoNotesDoc: (
    scope: WorktreeTodoScope,
    ownerId: string,
    todoId: string,
    body: string
  ) => Promise<boolean>
}

export function createTodoNoteActions(set: TodoSet, get: () => AppState): TodoNoteActions {
  return {
    addTodoNote: async (scope, ownerId, todoId, body) => {
      // Why: reject an empty entry; keep non-empty body verbatim. Mirrors addTodo's
      // optimistic-add + per-owner persist-queue + rollback. createdAt is stamped
      // with Date.now() exactly like addTodo stamps a new todo.
      const trimmed = body.trim()
      if (!trimmed) {
        return null
      }
      let created: TodoNote | null = null
      const result = mutateTodoNotes(set, scope, ownerId, todoId, (notes) => {
        created = {
          id: generateNoteId(),
          body: trimmed,
          authorRole: 'user',
          createdAt: Date.now()
        }
        return [...notes, created]
      })
      if (!result || !created) {
        return null
      }
      try {
        await enqueueTodoPersist(scope, ownerId, get)
        return created
      } catch (err) {
        console.error('Failed to persist todos:', err)
        rollbackTodos(set, scope, ownerId, result.previous, result.next)
        return null
      }
    },

    updateTodoNote: async (scope, ownerId, todoId, noteId, body) => {
      // Why: reject an empty edit (treat as not-committed) so a note never renders
      // blank. A same-body no-op returns true so the editor closes cleanly.
      const trimmed = body.trim()
      if (!trimmed) {
        return false
      }
      const result = mutateTodoNotes(set, scope, ownerId, todoId, (notes) => {
        const idx = notes.findIndex((n) => n.id === noteId)
        if (idx === -1 || notes[idx].body === trimmed) {
          return null
        }
        const next = notes.slice()
        next[idx] = { ...notes[idx], body: trimmed, updatedAt: Date.now() }
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

    deleteTodoNote: async (scope, ownerId, todoId, noteId) => {
      const result = mutateTodoNotes(set, scope, ownerId, todoId, (notes) => {
        const next = notes.filter((n) => n.id !== noteId)
        return next.length === notes.length ? null : next
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

    setTodoNotesDoc: async (scope, ownerId, todoId, body) => {
      // Why: keep the page markdown verbatim (headings/indentation matter); a blank
      // body collapses to undefined, which also clears the page meta. Every save
      // stamps author='user' + time.
      const cleaned = body.trim().length > 0 ? body : undefined
      const result = mutateTodos(set, scope, ownerId, (current) => {
        const idx = current.findIndex((t) => t.id === todoId)
        if (idx === -1 || current[idx].notesDoc === cleaned) {
          return null
        }
        const next = current.slice()
        next[idx] =
          cleaned === undefined
            ? {
                ...current[idx],
                notesDoc: undefined,
                notesDocAuthorRole: undefined,
                notesDocUpdatedAt: undefined
              }
            : {
                ...current[idx],
                notesDoc: cleaned,
                notesDocAuthorRole: 'user',
                notesDocUpdatedAt: Date.now()
              }
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
    }
  }
}
