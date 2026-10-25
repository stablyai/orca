import { useCallback, useEffect, useRef, useState } from 'react'
import type { WslHostDistro } from '../../../../shared/wsl-host-types'

/**
 * The registered WSL distros while the add dialog is open. Re-read when the window regains focus
 * or becomes visible (a distro imported meanwhile shows up) and on demand; never on a timer, since
 * each read spawns reg.exe and `wsl.exe --list --running`.
 */
export function useWslDistroList(enabled: boolean): {
  distros: WslHostDistro[]
  loading: boolean
  refreshing: boolean
  error: string | null
  refresh: () => void
} {
  const [distros, setDistros] = useState<WslHostDistro[]>([])
  const [loading, setLoading] = useState(enabled)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)

  const refresh = useCallback(() => {
    const api = window.api.runtimeEnvironments?.wslHosts
    // Why skip rather than queue: focus and visibility fire together; one read answers both.
    if (!api || inFlight.current) {
      return
    }
    inFlight.current = true
    setRefreshing(true)
    void api
      .listDistros()
      .then((list) => {
        if (mounted.current) {
          setDistros(list)
          setError(null)
        }
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        inFlight.current = false
        if (mounted.current) {
          setLoading(false)
          setRefreshing(false)
        }
      })
  }, [])

  useEffect(() => {
    mounted.current = true
    if (!enabled) {
      return () => {
        mounted.current = false
      }
    }
    refresh()
    const onFocus = (): void => refresh()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      mounted.current = false
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, refresh])

  return { distros, loading: enabled && loading, refreshing, error, refresh }
}
