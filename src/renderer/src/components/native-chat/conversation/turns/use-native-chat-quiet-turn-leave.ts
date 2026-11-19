import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'

/** The fade (300 ms) and close (280 ms), plus a frame. */
const LEAVE_MS = 600
export const NO_LEAVING_TURNS: ReadonlySet<string> = new Set()

/** Marks, in `setLeaving`, a quiet turn that settled while this chat showed it working, so it draws a
 *  moment longer and its bar and rows fade out instead of vanishing. A turn already quiet when the
 *  chat opens just isn't drawn, and with reduced motion one goes at once. */
export function useNativeChatQuietTurnLeave({
  quietTurnKeys,
  liveTurnKey,
  working,
  setLeaving
}: {
  quietTurnKeys: ReadonlySet<string>
  liveTurnKey: string | undefined
  working: boolean
  setLeaving: Dispatch<SetStateAction<ReadonlySet<string>>>
}): void {
  const reduceMotion = usePrefersReducedMotion()
  // The turn this chat last showed working, until it settles.
  const watched = useRef<string | undefined>(undefined)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  // Before paint, so the settled frame still draws the rows that now fade.
  useLayoutEffect(() => {
    if (working && liveTurnKey !== undefined) {
      watched.current = liveTurnKey
      return
    }
    const key = watched.current
    if (key === undefined || !quietTurnKeys.has(key)) {
      return
    }
    watched.current = undefined
    if (reduceMotion) {
      return
    }
    setLeaving((turns) => new Set([...turns, key]))
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setLeaving((turns) => {
        const next = new Set(turns)
        next.delete(key)
        return next.size ? next : NO_LEAVING_TURNS
      })
    }, LEAVE_MS)
    timers.current.add(timer)
  }, [liveTurnKey, quietTurnKeys, reduceMotion, setLeaving, working])
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(clearTimeout)
  }, [])
}
