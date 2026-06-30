import { useCallback, useState } from 'react'

export type TerminalErrorEntry = {
  message: string
  count: number
  lastSeenAt: number
}

// Why: 30s window collapses repeat WS-drop messages into a single row with a
// rising count, so the toast can't grow unboundedly while a multiplex is
// flapping. The 5-entry cap mirrors what the user can actually scan.
const ERROR_DEDUP_WINDOW_MS = 30_000
const ERROR_TABLE_MAX_ENTRIES = 5

export type TerminalErrorTable = {
  errors: TerminalErrorEntry[]
  push: (message: string) => void
  clear: () => void
}

export function useTerminalErrorTable(now: () => number = Date.now): TerminalErrorTable {
  const [errors, setErrors] = useState<TerminalErrorEntry[]>([])

  const push = useCallback(
    (message: string) => {
      const ts = now()
      setErrors((prev) => {
        const kept = prev.filter((e) => ts - e.lastSeenAt < ERROR_DEDUP_WINDOW_MS)
        const existing = kept.find((e) => e.message === message)
        if (existing) {
          return kept.map((e) =>
            e === existing ? { ...e, count: e.count + 1, lastSeenAt: ts } : e
          )
        }
        return [...kept, { message, count: 1, lastSeenAt: ts }].slice(-ERROR_TABLE_MAX_ENTRIES)
      })
    },
    [now]
  )

  const clear = useCallback(() => setErrors([]), [])

  return { errors, push, clear }
}
