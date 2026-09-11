import type { QuickNote } from '../../../../shared/quick-note-types'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

const QUERY_MAX_BYTES = 2 * 1024

/** Case-insensitive substring filter over label + body, label matches ranked first. */
export function searchQuickNotes(notes: readonly QuickNote[], rawQuery: string): QuickNote[] {
  if (isClipboardTextByteLengthOverLimit(rawQuery, QUERY_MAX_BYTES)) {
    return []
  }
  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return [...notes]
  }
  const ranked: { note: QuickNote; score: number; index: number }[] = []
  notes.forEach((note, index) => {
    const label = note.label.toLowerCase()
    const body = note.body.toLowerCase()
    const score = label.includes(query) ? 0 : body.includes(query) ? 1 : -1
    if (score !== -1) {
      ranked.push({ note, score, index })
    }
  })
  ranked.sort((a, b) => a.score - b.score || a.index - b.index)
  return ranked.map((entry) => entry.note)
}
