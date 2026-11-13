import { useEffect, useState } from 'react'

import { EMPTY_HERMES_PROFILES, type HermesProfilesSnapshot } from '../../../shared/hermes-profiles'

/** Named Hermes profiles for the local launch menu; remote and web clients keep the free-form field. */
export function useHermesProfiles(enabled: boolean): HermesProfilesSnapshot {
  const [snapshot, setSnapshot] = useState<HermesProfilesSnapshot>(EMPTY_HERMES_PROFILES)
  useEffect(() => {
    if (!enabled) {
      return
    }
    const api = window.api?.hermesProfiles
    if (!api) {
      return
    }
    let cancelled = false
    void api
      .list()
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next)
        }
      })
      .catch(() => {
        // A host without the channel keeps the empty menu; Arguments still accepts --profile.
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return snapshot
}
