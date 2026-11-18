import { agentStateLabel } from '@/components/AgentStateDot'

const RINGS = [0, 700]

/** Working agent in the simple sidebar: a dot with rings spreading out like ripples on water. */
export function ZotzWorkingRipple(): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={agentStateLabel('working')}
      className="relative flex size-3 items-center justify-center"
    >
      {RINGS.map((delay) => (
        <span
          key={delay}
          aria-hidden
          className="absolute inset-0 animate-ping rounded-full bg-agent-working/60 [animation-duration:1.4s] motion-reduce:hidden"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
      <span aria-hidden className="relative size-2 rounded-full bg-agent-working" />
    </span>
  )
}
