import { useRef, useState } from 'react'
import type { WorkInboxItem } from '../../../../shared/work-inbox'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { changeWorkInboxStatus, workInboxTargetKey } from './work-inbox-client'

export function useWorkInboxStatus(
  target: RuntimeClientTarget | null,
  refresh: () => Promise<void>,
  replace: (item: WorkInboxItem) => void
) {
  const active = useRef(new Set<string>())
  const [states, setStates] = useState<Record<string, { busy: boolean; failed: boolean }>>({})
  const keyFor = (id: string): string => `${target ? workInboxTargetKey(target) : ''}\n${id}`
  const change = async (item: WorkInboxItem): Promise<void> => {
    if (!target || !['open', 'cancelled'].includes(item.status)) {
      return
    }
    const key = keyFor(item.id)
    if (active.current.has(key)) {
      return
    }
    active.current.add(key)
    setStates((previous) => ({ ...previous, [key]: { busy: true, failed: false } }))
    try {
      const result = await changeWorkInboxStatus(
        target,
        item.status === 'open' ? 'cancel' : 'reopen',
        {
          id: item.id,
          expectedRevision: item.revision
        }
      )
      if (result.status !== 'not-found') {
        replace(result.item)
      }
      setStates((previous) => ({
        ...previous,
        [key]: { busy: false, failed: result.status !== 'ok' }
      }))
      await refresh()
    } catch {
      // Retrying uses the same revision; a later answer or reopen cannot be cancelled by this request.
      setStates((previous) => ({ ...previous, [key]: { busy: false, failed: true } }))
    } finally {
      active.current.delete(key)
    }
  }
  return { change, state: (id: string) => states[keyFor(id)] }
}
