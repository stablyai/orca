import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'

/** The fade (300 ms) and close (280 ms), plus a frame. */
const LEAVE_MS = 600
export const NO_LEAVING_TURNS: ReadonlySet<string> = new Set()

/** Marks, in `leaving`, a quiet turn that settled while this chat showed it working, so it draws a
 *  moment longer and its bar and rows fade out instead of vanishing. A turn already quiet when the
 *  chat opens just isn't drawn, and with reduced motion one goes at once. */
export function useNativeChatQuietTurnLeave({
  quietTurnKeys,
  liveTurnKey,
  working,
  leaving,
  setLeaving
}: {
  quietTurnKeys: ReadonlySet<string>
  liveTurnKey: string | undefined
  working: boolean
  leaving: ReadonlySet<string>
  setLeaving: Dispatch<SetStateAction<ReadonlySet<string>>>
}): void {
  const reduceMotion = usePrefersReducedMotion()
  // The turn this chat last showed working, until it settles.
  const watched = useRef<string | undefined>(undefined)
  // Before paint, so the settled frame still draws the rows that now fade.
  useLayoutEffect(() => {
    // Before taking the next live turn, which can start in the same render the watched one settles.
    const key = watched.current
    if (key !== undefined && quietTurnKeys.has(key)) {
      watched.current = undefined
      if (!reduceMotion) {
        // Always a new Set, even if the key is still fading from an earlier settlement: the new
        // identity restarts the leave timer below. This can't loop, since a turn is only watched
        // while it isn't quiet, so each write needs a real not-quiet to quiet transition.
        setLeaving((turns) => new Set([...turns, key]))
      }
    }
    // Why: never watch a turn that is already quiet. The chat can still read working over a turn
    // that just settled quiet; re-arming on it would mark it leaving again on every rebuild, and
    // in a layout effect that loops (React #185).
    if (working && liveTurnKey !== undefined && !quietTurnKeys.has(liveTurnKey)) {
      watched.current = liveTurnKey
    }
  }, [liveTurnKey, quietTurnKeys, reduceMotion, setLeaving, working])
  // Once the last one has faded, they all go.
  useEffect(() => {
    if (leaving.size === 0) {
      return
    }
    const timer = setTimeout(() => setLeaving(NO_LEAVING_TURNS), LEAVE_MS)
    return () => clearTimeout(timer)
  }, [leaving, setLeaving])
}
