import { useSyncExternalStore } from 'react'

// Per-machine convenience: which conversations fix their failing checks on their own.
const STORAGE_KEY = 'zotz.prAutofix.v1'

type AutofixRecord = { enabled: boolean; lastSentHead: string | null }

let records: Record<string, AutofixRecord> = read()
const listeners = new Set<() => void>()

function read(): Record<string, AutofixRecord> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    const result: Record<string, AutofixRecord> = {}
    if (parsed && typeof parsed === 'object') {
      for (const [id, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && typeof value.enabled === 'boolean') {
          const head: unknown = value.lastSentHead
          result[id] = {
            enabled: value.enabled,
            lastSentHead: typeof head === 'string' ? head : null
          }
        }
      }
    }
    return result
  } catch {
    return {}
  }
}

function write(next: Record<string, AutofixRecord>): void {
  records = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private windows may refuse storage; the toggle still works for this session.
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useZotzPrAutofix(worktreeId: string): AutofixRecord {
  return useSyncExternalStore(subscribe, () => records[worktreeId] ?? DISABLED)
}

const DISABLED: AutofixRecord = { enabled: false, lastSentHead: null }

export function setZotzPrAutofix(worktreeId: string, enabled: boolean): void {
  write({ ...records, [worktreeId]: { ...(records[worktreeId] ?? DISABLED), enabled } })
}

/** One autofix per pushed head: a new push is a new chance, the same failures are not resent. */
export function markZotzPrAutofixSent(worktreeId: string, head: string): void {
  write({ ...records, [worktreeId]: { ...(records[worktreeId] ?? DISABLED), lastSentHead: head } })
}
