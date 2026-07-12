import { useCallback, useEffect, useState } from 'react'

export type WslDistroOptions = {
  available: boolean
  distros: string[]
  default: string | null
}

const EMPTY_OPTIONS: WslDistroOptions = { available: false, distros: [], default: null }

/**
 * Why: `wsl:getDistroOptions`'s availability/distro probes are process-lifetime
 * and failure-sticky (see Task 7), so a manual refresh must pass `refresh: true`
 * to bypass the cache instead of relying on remount.
 */
export function useWslDistroOptions(): {
  options: WslDistroOptions
  loading: boolean
  refresh: () => Promise<void>
} {
  const [options, setOptions] = useState<WslDistroOptions>(EMPTY_OPTIONS)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    setLoading(true)
    try {
      setOptions(await window.api.wsl.getDistroOptions({ refresh }))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const refresh = useCallback((): Promise<void> => load(true), [load])

  return { options, loading, refresh }
}
