import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

export type LandingStarState = 'loading' | 'starred' | 'not-starred' | 'web-fallback' | 'hidden'

/** Own star lookup at Landing lifetime so repo-catalog flicker cannot remount the footer button and repeat gh calls. */
export function useLandingOrcaStarState(): [
  LandingStarState,
  Dispatch<SetStateAction<LandingStarState>>
] {
  const [state, setState] = useState<LandingStarState>('loading')

  useEffect(() => {
    let cancelled = false
    void window.api.gh.checkOrcaStarred().then((result) => {
      if (cancelled) {
        return
      }
      if (result === null) {
        setState('web-fallback')
      } else {
        setState(result ? 'starred' : 'not-starred')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  return [state, setState]
}
