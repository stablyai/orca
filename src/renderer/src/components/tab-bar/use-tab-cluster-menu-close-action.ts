import { useCallback, useRef } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'

type TabClusterMenuCloseAction = {
  queueAfterClose: (action: () => void) => void
  runAfterClose: (event: Pick<Event, 'preventDefault'>) => boolean
}

export function useTabClusterMenuCloseAction(): TabClusterMenuCloseAction {
  const mountedRef = useMountedRef()
  const pendingActionRef = useRef<(() => void) | null>(null)
  const queueAfterClose = useCallback((action: () => void) => {
    pendingActionRef.current = action
  }, [])
  const runAfterClose = useCallback(
    (event: Pick<Event, 'preventDefault'>) => {
      if (!mountedRef.current) {
        // Why: a removed menu's delayed focus restoration can dismiss its replacement.
        event.preventDefault()
        return true
      }
      const action = pendingActionRef.current
      if (!action) {
        return false
      }
      pendingActionRef.current = null
      // Why: Restoring menu focus after mounting a rename field commits it on blur.
      event.preventDefault()
      action()
      return true
    },
    [mountedRef]
  )

  return { queueAfterClose, runAfterClose }
}
