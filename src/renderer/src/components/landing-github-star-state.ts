import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

export type LandingStarState = 'loading' | 'starred' | 'not-starred' | 'web-fallback' | 'hidden'

/**
 * Resolve the viewer's Orca star state once per Landing mount.
 *
 * Why it lives here and not in the star button: the button renders inside a
 * footer that is conditionally mounted on whether `repos` currently carries a
 * GitHub provider identity, and `repos` is rewritten wholesale on every
 * repo-catalog push. Every flicker of that condition re-ran the button's mount
 * effect and forked another `gh api user/starred/...` (#18234). Landing itself
 * only mounts when the user navigates, so the check runs once per visit.
 */
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
