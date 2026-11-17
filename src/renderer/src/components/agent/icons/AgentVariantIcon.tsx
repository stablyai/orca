import { Users } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

/** A variant launched through its base agent keeps that agent's logo, marked by a corner badge. */
const VARIANT_BADGES: Partial<Record<TuiAgent, typeof Users>> = {
  'claude-agent-teams': Users
}

export function AgentVariantIcon({
  agent,
  size = 16
}: {
  agent: TuiAgent
  size?: number
}): React.JSX.Element {
  const Badge = VARIANT_BADGES[agent]
  if (!Badge) {
    return <AgentIcon agent={agent} size={size} />
  }
  return (
    <span className="relative inline-grid shrink-0" style={{ width: size, height: size }}>
      <AgentIcon agent={agent} size={size} />
      <span
        aria-hidden
        className="absolute -right-[5px] -bottom-1 grid size-[11px] place-items-center rounded-full bg-popover text-foreground ring-1 ring-popover"
      >
        <Badge className="size-2" />
      </span>
    </span>
  )
}
