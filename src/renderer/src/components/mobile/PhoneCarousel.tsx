import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { HomeSlide } from './slides/HomeSlide'
import { WorktreeListSlide } from './slides/WorktreeListSlide'
import { TerminalSlide } from './slides/TerminalSlide'

const DWELL_MS = 4500
const TAP_BEFORE_PUSH_MS = 240

type Phase = 'normal' | 'reset'

export function PhoneCarousel(): React.JSX.Element {
  const [activeIdx, setActiveIdx] = useState(0)
  const [phase, setPhase] = useState<Phase>('normal')
  const [tappingSlide, setTappingSlide] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      return
    }

    let cancelled = false
    let dwellTimer: ReturnType<typeof setTimeout> | null = null
    let tapTimer: ReturnType<typeof setTimeout> | null = null
    let advanceTimer: ReturnType<typeof setTimeout> | null = null
    let resetTimer: ReturnType<typeof setTimeout> | null = null

    const schedule = (idx: number): void => {
      dwellTimer = setTimeout(() => {
        if (cancelled) {
          return
        }
        // Pulse the tap target on the current slide, then advance.
        if (idx < 2) {
          setTappingSlide(idx)
          tapTimer = setTimeout(() => {
            if (cancelled) {
              return
            }
            setTappingSlide(null)
          }, 320)
          advanceTimer = setTimeout(() => {
            if (cancelled) {
              return
            }
            const next = idx + 1
            setActiveIdx(next)
            schedule(next)
          }, TAP_BEFORE_PUSH_MS)
        } else {
          // Hard cut back to home — snap with no transition, then re-enable.
          setPhase('reset')
          setActiveIdx(0)
          resetTimer = setTimeout(() => {
            if (cancelled) {
              return
            }
            setPhase('normal')
            schedule(0)
          }, 30)
        }
      }, DWELL_MS)
    }

    // oxlint-disable-next-line react-doctor/no-initialize-state -- Why: the first tap pulse is intentionally delayed until after the initial dwell.
    schedule(0)

    return () => {
      cancelled = true
      if (dwellTimer) {
        clearTimeout(dwellTimer)
      }
      if (tapTimer) {
        clearTimeout(tapTimer)
      }
      if (advanceTimer) {
        clearTimeout(advanceTimer)
      }
      if (resetTimer) {
        clearTimeout(resetTimer)
      }
    }
  }, [])

  // Why: while the slide reset is in progress we want all slides to snap
  // back to their off-stage positions with no transition; the next render
  // tick removes is-reset so the subsequent push animates again.
  useEffect(() => {
    if (phase !== 'reset') {
      return
    }
    const id = requestAnimationFrame(() => {
      // force layout so the no-transition state takes effect before
      // transitions are re-enabled
      void containerRef.current?.offsetHeight
    })
    return () => cancelAnimationFrame(id)
  }, [phase])

  const slideClass = (idx: number): string =>
    cn(
      'mp-screen-slide',
      phase === 'reset' && 'is-reset',
      idx === activeIdx && 'is-active',
      idx < activeIdx && 'is-past'
    )

  return (
    <div className="mp-phone-frame">
      <div className="mp-phone-screen" ref={containerRef}>
        <div className={slideClass(0)} role="img" aria-label="Orca Mobile home screen">
          <HomeSlide tapping={tappingSlide === 0} />
        </div>
        <div className={slideClass(1)} role="img" aria-label="Worktree list">
          <WorktreeListSlide tapping={tappingSlide === 1} />
        </div>
        <div className={slideClass(2)} role="img" aria-label="Terminal session">
          <TerminalSlide />
        </div>
      </div>
    </div>
  )
}
