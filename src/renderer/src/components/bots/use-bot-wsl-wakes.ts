// The sleeping WSL hosts New bot woke and is waiting on, so they read "Waking…" rather than "Can't reach".
import { useCallback, useRef, useState } from 'react'
import { startWslHostAndReloadProjects } from '@/runtime/hosts/wsl/wsl-host-user-start'

const NONE: ReadonlySet<string> = new Set()

export function useBotWslWakes(): {
  waking: ReadonlySet<string>
  /** Wakes the host once; a later idle stop may wake it again after this wake settles. */
  wake: (environmentId: string) => void
} {
  const [waking, setWaking] = useState(NONE)
  const inFlight = useRef(new Set<string>())
  const wake = useCallback((environmentId: string): void => {
    if (inFlight.current.has(environmentId)) {
      return
    }
    inFlight.current.add(environmentId)
    setWaking((previous) => new Set(previous).add(environmentId))
    void startWslHostAndReloadProjects(environmentId).finally(() => {
      inFlight.current.delete(environmentId)
      setWaking((previous) => {
        const next = new Set(previous)
        next.delete(environmentId)
        return next
      })
    })
  }, [])
  return { waking, wake }
}
