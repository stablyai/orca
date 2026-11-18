import { agentStateLabel } from '@/components/AgentStateDot'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

const WIDTH = 20
const HEIGHT = 12
const PERIOD = 20

/** Two periods of a sine line, so shifting it by one period loops seamlessly. */
function wavePath(amplitude: number, phase: number): string {
  const points: string[] = []
  for (let x = 0; x <= WIDTH + PERIOD; x += 0.5) {
    const y = HEIGHT / 2 + amplitude * Math.sin((2 * Math.PI * x) / PERIOD + phase)
    points.push(`${points.length === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(2)}`)
  }
  return points.join(' ')
}

const WAVES = [
  { path: wavePath(3.6, 0), opacity: 1, seconds: 1.8 },
  { path: wavePath(2.8, 1.1), opacity: 0.7, seconds: 2.3 },
  { path: wavePath(2, 2.2), opacity: 0.45, seconds: 2.9 },
  { path: wavePath(1.3, 3.3), opacity: 0.25, seconds: 3.6 }
]

/** Working agent in the simple sidebar: thin blue lines flowing sideways like water. */
export function ZotzWorkingRipple(): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  return (
    <svg
      role="img"
      aria-label={agentStateLabel('working')}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className="shrink-0 overflow-hidden text-zotz-working-wave"
    >
      {WAVES.map((wave) => (
        <path
          key={wave.seconds}
          d={wave.path}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.8}
          strokeLinecap="round"
          opacity={wave.opacity}
        >
          {reducedMotion ? null : (
            <animateTransform
              attributeName="transform"
              type="translate"
              from="0 0"
              to={`${-PERIOD} 0`}
              dur={`${wave.seconds}s`}
              repeatCount="indefinite"
            />
          )}
        </path>
      ))}
    </svg>
  )
}
