import { useEffect, useState } from 'react'
import type { ComputerAwakeStatus } from '../../../shared/computer-awake-mode'

const INACTIVE_STATUS: ComputerAwakeStatus = {
  mode: 'off',
  active: false
}

/** Live main-process view of awake mode, activity, and macOS integration status. */
export function useComputerAwakeStatus(): ComputerAwakeStatus {
  const [status, setStatus] = useState<ComputerAwakeStatus>(INACTIVE_STATUS)

  useEffect(() => {
    let mounted = true
    // The startup Amphetamine probe publishes while getStatus() is still in
    // flight, so the older snapshot would otherwise land last and win.
    let receivedEvent = false
    const unsubscribe = window.api.agentAwake.onChanged((next) => {
      if (mounted) {
        receivedEvent = true
        setStatus(next)
      }
    })
    void window.api.agentAwake
      .getStatus()
      .then((next) => {
        if (mounted && !receivedEvent) {
          setStatus(next)
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  return status
}
