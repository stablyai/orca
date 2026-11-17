import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { EnvironmentsApi, EnvironmentStaleness } from './cloud-environment-types'

/** Staleness checks hit GitHub; re-check on focus at most this often. */
const STALENESS_FOCUS_THROTTLE_MS = 60_000

/**
 * The "should you rebuild?" signal: checked on open and after changes, and again (with a fresh
 * GitHub read) when the window regains focus — the user may have just pushed a lockfile.
 */
export function useEnvironmentStaleness(
  api: EnvironmentsApi,
  envIdRef: RefObject<string | null>
): {
  staleness: EnvironmentStaleness | null
  checkStaleness: (envId: string, refresh: boolean) => void
} {
  const [staleness, setStaleness] = useState<EnvironmentStaleness | null>(null)
  const lastCheckedAt = useRef(0)

  const checkStaleness = useCallback(
    (envId: string, refresh: boolean): void => {
      lastCheckedAt.current = Date.now()
      void api
        .staleness(envId, refresh)
        .then((result) => {
          if (result.ok && envIdRef.current === envId) {
            setStaleness(result.data.staleness)
          }
        })
        .catch(() => undefined)
    },
    [api, envIdRef]
  )

  useEffect(() => {
    const onFocus = (): void => {
      const envId = envIdRef.current
      if (envId && Date.now() - lastCheckedAt.current > STALENESS_FOCUS_THROTTLE_MS) {
        checkStaleness(envId, true)
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkStaleness, envIdRef])

  return { staleness, checkStaleness }
}
