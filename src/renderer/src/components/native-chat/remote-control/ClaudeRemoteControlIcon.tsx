import { RadioTower } from 'lucide-react'
import { AgentBadgedIcon } from '@/components/agent/icons/AgentVariantIcon'
import { cn } from '@/lib/class-names'
import type { AgentSessionProviderRemoteControlState } from '../../../../../shared/agent-session/remote-control/agent-session-provider-remote-control'

const BADGE_STATE: Record<AgentSessionProviderRemoteControlState | 'pending', string> = {
  pending: 'text-muted-foreground',
  connected: 'text-status-success',
  connecting: 'text-muted-foreground motion-safe:animate-pulse',
  failed: 'text-chat-warning',
  'policy-disabled': 'text-chat-warning'
}

/** Claude's own logo with a broadcast badge; the badge alone carries the link's state color. */
export function ClaudeRemoteControlIcon({
  size = 14,
  state
}: {
  size?: number
  /** Absent: off, a plain badge. `pending`: turned on, waiting for the agent to start. */
  state?: AgentSessionProviderRemoteControlState | 'pending'
}): React.JSX.Element {
  return (
    <AgentBadgedIcon
      agent="claude"
      size={size}
      surface="chat-canvas"
      badge={<RadioTower className={cn('size-2', state ? BADGE_STATE[state] : undefined)} />}
    />
  )
}
