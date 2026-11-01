import { useCallback, useEffect, useState } from 'react'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { readTaskNote, taskNoteIdentity, type DashboardTaskNote } from './agent-task-status'

const PREFIX = 'orca:dashboard-task-note:v1:'
const CHANGED = 'orca-dashboard-task-notes-changed'

function loadNotes(): Record<string, DashboardTaskNote> {
  const notes: Record<string, DashboardTaskNote> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX)) {
        continue
      }
      const note = readTaskNote(localStorage.getItem(key))
      if (note) {
        notes[key.slice(PREFIX.length)] = note
      }
    }
  } catch {
    // Saving reports storage failures in the editor; reading must not hide live agents.
  }
  return notes
}

export function useDashboardTaskNotes(): {
  notes: Record<string, DashboardTaskNote>
  saveNote: (card: DashboardCard, note: DashboardTaskNote) => void
} {
  const [notes, setNotes] = useState(loadNotes)
  useEffect(() => {
    const refresh = (): void => setNotes(loadNotes())
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key.startsWith(PREFIX)) {
        refresh()
      }
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(CHANGED, refresh)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(CHANGED, refresh)
    }
  }, [])
  const saveNote = useCallback((card: DashboardCard, note: DashboardTaskNote) => {
    // One key per agent avoids overwriting another window's updates to other agents.
    localStorage.setItem(PREFIX + taskNoteIdentity(card), JSON.stringify(note))
    window.dispatchEvent(new Event(CHANGED))
  }, [])
  return { notes, saveNote }
}
