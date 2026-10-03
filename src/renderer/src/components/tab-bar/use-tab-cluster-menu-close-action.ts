import { useCallback, useRef } from 'react'

type TabClusterMenuCloseAction = {
  queueAfterClose: (action: () => void) => void
  runAfterClose: (event: Pick<Event, 'preventDefault'>) => boolean
}

export function useTabClusterMenuCloseAction(): TabClusterMenuCloseAction {
  const pendingActionRef = useRef<(() => void) | null>(null)
  const queueAfterClose = useCallback((action: () => void) => {
    pendingActionRef.current = action
  }, [])
  const runAfterClose = useCallback((event: Pick<Event, 'preventDefault'>) => {
    const action = pendingActionRef.current
    if (!action) {
      return false
    }
    pendingActionRef.current = null
    // Why: Restoring menu focus after mounting a rename field commits it on blur.
    event.preventDefault()
    action()
    return true
  }, [])

  return { queueAfterClose, runAfterClose }
}
