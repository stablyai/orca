import type { TodoNote, WorktreeTodoAuthorRole } from '../../../../shared/types'
import { createBrowserUuid } from '@/lib/browser-uuid'

export function generateNoteId(): string {
  return createBrowserUuid()
}

// Why: drop malformed timeline entries (missing id / empty body / invalid
// createdAt) so a corrupt persisted note can't crash the renderer. Body is
// kept verbatim (newlines are meaningful); only entirely-blank bodies fail.
export function normalizeNote(note: unknown): TodoNote | null {
  if (!note || typeof note !== 'object') {
    return null
  }
  const candidate = note as Partial<TodoNote>
  const id = typeof candidate.id === 'string' && candidate.id.length > 0 ? candidate.id : null
  const body = typeof candidate.body === 'string' ? candidate.body : ''
  const createdAt =
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    candidate.createdAt > 0
      ? candidate.createdAt
      : null
  if (!id || body.trim().length === 0 || createdAt === null) {
    return null
  }
  const authorRole: WorktreeTodoAuthorRole = candidate.authorRole === 'agent' ? 'agent' : 'user'
  const rawUpdatedAt = candidate.updatedAt
  const updatedAt =
    typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
      ? rawUpdatedAt
      : undefined
  return { id, body, authorRole, createdAt, ...(updatedAt !== undefined ? { updatedAt } : {}) }
}

// Why: clean a raw notes value into a TodoNote[]. Also migrates the pre-timeline
// single-string shape into one user entry stamped with the todo's own createdAt,
// so notes written by the previous version aren't lost on first load.
export function normalizeNotes(rawNotes: unknown, todoCreatedAt: number): TodoNote[] {
  if (typeof rawNotes === 'string') {
    const body = rawNotes.trim()
    return body
      ? [{ id: generateNoteId(), body, authorRole: 'user', createdAt: todoCreatedAt }]
      : []
  }
  if (Array.isArray(rawNotes)) {
    return rawNotes.map(normalizeNote).filter((n): n is TodoNote => n !== null)
  }
  return []
}
