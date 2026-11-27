import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'

export type FeatureTipRotatingSlotItem = { key: string; label: string; icon: ReactNode }

/** Each name stays this long; slots on one card start together, so they change in step. */
export const ROTATING_SLOT_STEP_MS = 3600
const SLIDE_MS = 550

/** One name at a time slides up into an inline slot whose width follows the name in view. */
export function FeatureTipRotatingSlot({
  items,
  staticLabel,
  delayMs = 0
}: {
  items: readonly FeatureTipRotatingSlotItem[]
  /** Shown in place of the slot with reduced motion, and read by screen readers. */
  staticLabel: string
  delayMs?: number
}): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  // items.length is a copy of the first name: landing there snaps back to 0 unseen.
  const [index, setIndex] = useState(0)
  const [widths, setWidths] = useState<number[]>([])
  const itemRefs = useRef<(HTMLSpanElement | null)[]>([])
  const labelsKey = items.map((item) => item.label).join('\n')

  useLayoutEffect(() => {
    setWidths(itemRefs.current.map((element) => element?.scrollWidth ?? 0))
  }, [labelsKey, reducedMotion])

  const still = reducedMotion || items.length < 2
  useEffect(() => {
    if (still) {
      return
    }
    let intervalId: number | undefined
    const startId = window.setTimeout(() => {
      intervalId = window.setInterval(
        () => setIndex((current) => current + 1),
        ROTATING_SLOT_STEP_MS
      )
    }, delayMs)
    return () => {
      window.clearTimeout(startId)
      window.clearInterval(intervalId)
    }
  }, [delayMs, still])

  useEffect(() => {
    if (index < items.length) {
      return
    }
    const snapId = window.setTimeout(() => setIndex(0), SLIDE_MS + 50)
    return () => window.clearTimeout(snapId)
  }, [index, items.length])

  if (reducedMotion) {
    return <span className="font-semibold text-foreground">{staticLabel}</span>
  }

  // Index 0 is only ever reached by the snap back, so it never animates.
  const motion = index === 0 ? 'none' : `transform ${SLIDE_MS}ms, width ${SLIDE_MS}ms`
  const easing = 'cubic-bezier(0.22, 1, 0.36, 1)'
  return (
    <>
      <span className="sr-only">{staticLabel}</span>
      <span
        aria-hidden
        className="relative inline-block h-5 overflow-hidden align-bottom"
        style={{ width: widths[index], transition: motion, transitionTimingFunction: easing }}
      >
        <span
          className="flex flex-col items-start"
          style={{
            transform: `translateY(${-index * 1.25}rem)`,
            transition: motion,
            transitionTimingFunction: easing
          }}
        >
          {[...items, items[0]].map((item, position) => (
            <span
              key={position}
              ref={(element) => {
                itemRefs.current[position] = element
              }}
              className="flex h-5 items-center gap-1.5 font-semibold whitespace-nowrap text-foreground"
            >
              <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span>
              {item.label}
            </span>
          ))}
        </span>
      </span>
    </>
  )
}
