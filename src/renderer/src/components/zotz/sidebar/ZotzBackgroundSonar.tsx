import { useEffect, useRef } from 'react'
import { agentStateLabel } from '@/components/AgentStateDot'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

const WIDTH = 20
const HEIGHT = 12
const SOURCE_X = 8
const MID_Y = HEIGHT / 2
const RESTING_OPACITY = 0.35

/** Arc of `radius` around the source, opening to the right by ±`degrees`. */
function arcPath(radius: number, degrees: number): string {
  const angle = (degrees * Math.PI) / 180
  const x = (SOURCE_X + radius * Math.cos(angle)).toFixed(2)
  const dy = radius * Math.sin(angle)
  return `M${x} ${(MID_Y - dy).toFixed(2)} A${radius} ${radius} 0 0 1 ${x} ${(MID_Y + dy).toFixed(2)}`
}

const NEAR_ARC = arcPath(3.2, 50)
const FAR_ARC = arcPath(6, 45)

// Each arc lights once per sweep, the far one after the near, like an echo leaving the source.
function animateSonar(near: SVGPathElement, far: SVGPathElement): () => void {
  const timing = { duration: 1800, iterations: Infinity, easing: 'ease-in-out' }
  const nearPulse = near.animate(
    [
      { opacity: RESTING_OPACITY },
      { opacity: 1, offset: 0.25 },
      { opacity: RESTING_OPACITY, offset: 0.6 },
      { opacity: RESTING_OPACITY }
    ],
    timing
  )
  const farPulse = far.animate(
    [
      { opacity: RESTING_OPACITY },
      { opacity: RESTING_OPACITY, offset: 0.15 },
      { opacity: 1, offset: 0.45 },
      { opacity: RESTING_OPACITY, offset: 0.85 },
      { opacity: RESTING_OPACITY }
    ],
    timing
  )
  return () => {
    nearPulse.cancel()
    farPulse.cancel()
  }
}

/** Only background tasks still run (no agent turn): a bat's echo pulsing out, calmer than the working wave. */
export function ZotzBackgroundSonar(): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const nearRef = useRef<SVGPathElement>(null)
  const farRef = useRef<SVGPathElement>(null)

  useEffect(() => {
    const near = nearRef.current
    const far = farRef.current
    return near && far && !reducedMotion ? animateSonar(near, far) : undefined
  }, [reducedMotion])

  return (
    <svg
      role="img"
      aria-label={agentStateLabel('monitoring')}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className="shrink-0 text-zotz-working-wave"
    >
      <circle cx={SOURCE_X} cy={MID_Y} r={1.6} fill="currentColor" />
      <g fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
        <path ref={nearRef} d={NEAR_ARC} opacity={reducedMotion ? 0.7 : RESTING_OPACITY} />
        <path ref={farRef} d={FAR_ARC} opacity={reducedMotion ? 0.7 : RESTING_OPACITY} />
      </g>
    </svg>
  )
}
