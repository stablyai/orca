import { useState } from 'react'
import type { WorkerDockRowView } from './WorkerDockRow'

export function useWorkerDockRowCache(
  rows: ReadonlyMap<string, WorkerDockRowView>,
  active: string | null,
  focused: string | null
) {
  const [cache, setCache] = useState(() => ({ rows, active, focused, values: new Map(rows) }))
  if (cache.rows !== rows || cache.active !== active || cache.focused !== focused) {
    const values = new Map(rows)
    for (const id of [active, focused]) {
      const previous = id === null ? undefined : cache.values.get(id)
      if (previous && !values.has(previous.id)) {
        values.set(previous.id, previous)
      }
    }
    setCache({ rows, active, focused, values })
  }
  return cache.values
}
