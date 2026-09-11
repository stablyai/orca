import type { QuickNote } from './quick-note-types'

export const MAX_QUICK_NOTES = 40
export const MAX_QUICK_NOTE_ID_LENGTH = 80
export const MAX_QUICK_NOTE_LABEL_LENGTH = 80
export const MAX_QUICK_NOTE_BODY_LENGTH = 10000

export type QuickNoteMutation = { type: 'upsert'; note: QuickNote } | { type: 'delete'; id: string }

export function getDefaultQuickNotes(): QuickNote[] {
  return []
}

export function normalizeQuickNotes(input: unknown): QuickNote[] {
  if (!Array.isArray(input)) {
    return []
  }

  const normalized: QuickNote[] = []
  const seenIds = new Set<string>()

  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const record = item as Record<string, unknown>
    const hasLabel = typeof record.label === 'string'
    const hasBody = typeof record.body === 'string'
    // Why: settings saves on every edit; keep half-filled rows so a freshly
    // added note is not dropped before the user finishes typing.
    if (!hasLabel && !hasBody) {
      continue
    }

    const rawId = typeof record.id === 'string' ? record.id.trim() : ''
    const idBase = rawId || `quick-note-${normalized.length + 1}`
    let id = idBase.slice(0, MAX_QUICK_NOTE_ID_LENGTH)
    let suffix = 2
    while (seenIds.has(id)) {
      id = `${idBase.slice(0, MAX_QUICK_NOTE_ID_LENGTH - 4)}-${suffix}`
      suffix += 1
    }
    seenIds.add(id)

    normalized.push({
      id,
      label: (hasLabel ? String(record.label).trim() : '').slice(0, MAX_QUICK_NOTE_LABEL_LENGTH),
      body: (hasBody ? String(record.body).trimEnd() : '').slice(0, MAX_QUICK_NOTE_BODY_LENGTH)
    })

    if (normalized.length >= MAX_QUICK_NOTES) {
      break
    }
  }

  return normalized
}

export function isQuickNoteComplete(note: QuickNote): boolean {
  return note.label.trim().length > 0 && note.body.trim().length > 0
}

export function applyQuickNoteMutation(
  notes: readonly QuickNote[],
  mutation: QuickNoteMutation
): QuickNote[] {
  if (mutation.type === 'delete') {
    return notes.filter((note) => note.id !== mutation.id)
  }
  const existingIndex = notes.findIndex((note) => note.id === mutation.note.id)
  if (existingIndex === -1) {
    return [...notes, mutation.note]
  }
  return notes.map((note, index) => (index === existingIndex ? mutation.note : note))
}
