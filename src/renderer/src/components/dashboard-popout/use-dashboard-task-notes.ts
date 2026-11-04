import { useCallback, useEffect, useState } from 'react'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  taskNoteKeySchema,
  type DashboardTaskNotes,
  type DashboardTaskNoteChange
} from '../../../../shared/dashboard-task-notes'
import { readTaskNote, taskNoteIdentity, type DashboardTaskNote } from './agent-task-status'

const PREFIX = 'orca:dashboard-task-note:v1:'
const CHANGED = 'orca-dashboard-task-notes-changed'

function loadLegacyNotes(): DashboardTaskNotes {
  const notes: DashboardTaskNotes = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (
        !key?.startsWith(PREFIX) ||
        !taskNoteKeySchema.safeParse(key.slice(PREFIX.length)).success
      ) {
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
  notes: DashboardTaskNotes
  error: boolean
  saveNote: (card: DashboardCard, note: DashboardTaskNote) => Promise<void>
} {
  const [api] = useState(() => {
    const candidate = window.api?.dashboard?.taskNotes
    // Web's fallback Proxy fabricates methods; require the desktop capability marker.
    return candidate?.storage === 'profile' ? candidate : undefined
  })
  const [notes, setNotes] = useState<DashboardTaskNotes>(() => (api ? {} : loadLegacyNotes()))
  const [error, setError] = useState(false)
  useEffect(() => {
    if (api) {
      let active = true
      let loading = true
      const pending: DashboardTaskNotes = {}
      const unsubscribe = api.onChanged(({ key, note }: DashboardTaskNoteChange) => {
        if (!active) {
          return
        }
        if (loading) {
          pending[key] = note
        }
        setNotes((current) => ({ ...current, [key]: note }))
      })
      void api
        .get()
        .then(async (snapshot) => {
          if (!active) {
            return
          }
          const initial = { ...snapshot, ...pending }
          loading = false
          setNotes(initial)
          for (const [key, note] of Object.entries(loadLegacyNotes())) {
            if (!active) {
              return
            }
            if (!initial[key]) {
              // The main process checks again atomically; never delete the legacy source.
              await api.set({ key, note, mode: 'import-if-missing' })
            }
          }
        })
        .catch(() => {
          if (active) {
            setError(true)
          }
        })
      return () => {
        active = false
        unsubscribe()
      }
    }
    const refresh = (): void => setNotes(loadLegacyNotes())
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
  }, [api])
  const saveNote = useCallback(
    async (card: DashboardCard, note: DashboardTaskNote) => {
      const key = taskNoteIdentity(card)
      if (api) {
        await api.set({ key, note })
        return
      }
      localStorage.setItem(PREFIX + key, JSON.stringify(note))
      window.dispatchEvent(new Event(CHANGED))
    },
    [api]
  )
  return { notes, error, saveNote }
}
