import { Users } from 'lucide-react'
import type React from 'react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { cn } from '@/lib/class-names'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

/** A variant launched through its base agent keeps that agent's logo, marked by a corner badge. */
const VARIANT_BADGES: Partial<Record<TuiAgent, typeof Users>> = {
  'claude-agent-teams': Users
}

/** An agent's own logo marked by a corner badge: how a variant or feature of that agent reads. */
export function AgentBadgedIcon({
  agent,
  size = 16,
  badge,
  surface = 'popover'
}: {
  agent: TuiAgent
  size?: number
  badge: React.ReactNode
  /** What the badge sits on, so its disc reads as a cut-out of that surface. */
  surface?: 'popover' | 'chat-canvas'
}): React.JSX.Element {
  return (
    <span className="relative inline-grid shrink-0" style={{ width: size, height: size }}>
      {/* size-full: a Button sizes any svg without a size class to size-4. */}
      <AgentIcon agent={agent} size={size} className="size-full" />
      <span
        aria-hidden
        className={cn(
          'absolute -right-[5px] -bottom-1 grid size-[11px] place-items-center rounded-full text-foreground ring-1',
          surface === 'chat-canvas' ? 'bg-chat-canvas ring-chat-canvas' : 'bg-popover ring-popover'
        )}
      >
        {badge}
      </span>
    </span>
  )
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
  return <AgentBadgedIcon agent={agent} size={size} badge={<Badge className="size-2" />} />
}
