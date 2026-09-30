import { useEffect, useState } from 'react'
import { createDelayedStatus, type ShownStatus } from '@/lib/delayed-status'

/**
 * Returns `value` only once it has lasted past `showDelayMs`, then holds it for a
 * minimum time, so a short status never flashes. `key` is what the status belongs
 * to (for example a session); a new key drops it at once.
 */
export function useDelayedStatus<A>(key: string, value: A | null, showDelayMs: number): A | null {
  const [shown, setShown] = useState<ShownStatus<A> | null>(null)
  const [status] = useState(() => createDelayedStatus<A>(setShown, { showDelayMs }))
  useEffect(() => () => status.dispose(), [status])
  useEffect(() => {
    status.update(key, value)
  }, [status, key, value])
  return shown?.key === key ? shown.value : null
}
