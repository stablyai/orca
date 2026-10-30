import { useLayoutEffect, useRef, useState } from 'react'
import {
  CALM_STATUS_IDLE,
  stepCalmStatusReveal,
  type CalmStatusReveal
} from '../../../shared/calm-status-reveal'

export type CalmStatusView = { visible: boolean; downSince: number | null }

const HIDDEN: CalmStatusView = { visible: false, downSince: null }

/** Says a self-healing outage only once it outlasts a reconnect, and never as a flash. */
export function useCalmStatusReveal(
  down: boolean,
  immediate: boolean,
  since: number | null = null
): CalmStatusView {
  const revealRef = useRef<CalmStatusReveal>(CALM_STATUS_IDLE)
  const [view, setView] = useState<CalmStatusView>(HIDDEN)
  const [wake, setWake] = useState(0)
  // Why layout: an immediate notice must not paint one frame late.
  useLayoutEffect(() => {
    const step = stepCalmStatusReveal(revealRef.current, {
      down,
      immediate,
      now: Date.now(),
      since
    })
    revealRef.current = step.next
    setView((previous) =>
      previous.visible === step.visible && previous.downSince === step.next.downSince
        ? previous
        : { visible: step.visible, downSince: step.next.downSince }
    )
    if (step.recheckInMs === null) {
      return
    }
    const timer = setTimeout(() => setWake((count) => count + 1), Math.max(0, step.recheckInMs))
    return () => clearTimeout(timer)
  }, [down, immediate, since, wake])
  return view
}
