import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import { isResourceViewInactive } from '../../../../shared/resource-view-admission'

export function useResourceMemorySnapshot(active: boolean): () => Promise<void> {
  const lifetime = useRef<{
    active: boolean
    epoch: number
    inFlight: { epoch: number; promise: Promise<void> } | null
  }>({
    active: false,
    epoch: 0,
    inFlight: null
  })
  const refresh = useCallback(async (): Promise<void> => {
    const current = lifetime.current
    if (!current.active) {
      return
    }
    const epoch = current.epoch
    if (current.inFlight) {
      const dispatched = current.inFlight
      await dispatched.promise
      if (
        !current.active ||
        current.epoch !== epoch ||
        dispatched.epoch === epoch ||
        current.inFlight?.epoch === epoch
      ) {
        return
      }
    }
    const request = window.api.memory
      .getSnapshot({ resourceManagerView: true })
      .then((snapshot) => {
        if (current.active && current.epoch === epoch) {
          useAppStore.setState({ memorySnapshot: snapshot, memorySnapshotError: null })
        }
      })
      .catch((error: unknown) => {
        if (current.active && current.epoch === epoch && !isResourceViewInactive(error)) {
          useAppStore.setState({ memorySnapshotError: String(error) })
        }
      })
    current.inFlight = { epoch, promise: request }
    await request
    if (current.inFlight?.promise === request) {
      current.inFlight = null
    }
  }, [])
  useEffect(() => {
    const current = lifetime.current
    current.active = active
    current.epoch++
    if (!active) {
      return
    }
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 2_000)
    return () => {
      current.active = false
      current.epoch++
      window.clearInterval(timer)
    }
  }, [active, refresh])
  return refresh
}
