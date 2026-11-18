import { useEffect, useId, useRef } from 'react'
import { agentStateLabel } from '@/components/AgentStateDot'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

const WIDTH = 20
const HEIGHT = 12
const PERIOD = 10

/** Two periods past the box so shifting by one period loops seamlessly; same point count at any height. */
function wavePath(amplitude: number): string {
  const points: string[] = []
  for (let x = 0; x <= WIDTH + PERIOD; x += 0.5) {
    const y = HEIGHT / 2 + amplitude * Math.sin((2 * Math.PI * x) / PERIOD)
    points.push(`${points.length === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(2)}`)
  }
  return points.join(' ')
}

const CALM = wavePath(1.6)
const SWELL = wavePath(3.8)

// Web Animations, not SMIL: Chromium does not reliably start SMIL nodes React inserts late.
function animateWave(path: SVGPathElement): () => void {
  const flow = path.animate(
    [{ transform: 'translateX(0)' }, { transform: `translateX(${-PERIOD}px)` }],
    { duration: 1200, iterations: Infinity, easing: 'linear' }
  )
  const swell = path.animate(
    [{ d: `path("${CALM}")` }, { d: `path("${SWELL}")` }, { d: `path("${CALM}")` }],
    { duration: 2400, iterations: Infinity, easing: 'ease-in-out' }
  )
  return () => {
    flow.cancel()
    swell.cancel()
  }
}

/** Working agent in the simple sidebar: one blue wave flowing sideways while it swells and settles. */
export function ZotzWorkingRipple(): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const pathRef = useRef<SVGPathElement>(null)
  const id = useId()
  const fadeId = `${id}-fade`
  const maskId = `${id}-mask`

  useEffect(() => {
    const path = pathRef.current
    return path && !reducedMotion ? animateWave(path) : undefined
  }, [reducedMotion])

  return (
    <svg
      role="img"
      aria-label={agentStateLabel('working')}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className="shrink-0 overflow-hidden text-zotz-working-wave"
    >
      <defs>
        <linearGradient id={fadeId} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="0.3" stopColor="white" stopOpacity="1" />
          <stop offset="0.7" stopColor="white" stopOpacity="1" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id={maskId}>
          <rect width={WIDTH} height={HEIGHT} fill={`url(#${fadeId})`} />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <path
          ref={pathRef}
          d={CALM}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}
