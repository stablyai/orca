import { TriangleAlert } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import type { AgentType } from '../../../../shared/agent-status-types'

export function NativeChatInstallTile(props: {
  agent: AgentType
  failed: boolean
  large: boolean
}): React.JSX.Element {
  const { agent, failed, large } = props
  return (
    <div
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center border',
        large ? 'size-14 rounded-2xl' : 'size-9 rounded-xl',
        failed
          ? 'border-chat-warning/30 bg-chat-warning/10 text-chat-warning'
          : 'border-border bg-accent'
      )}
    >
      {failed ? (
        <TriangleAlert className={large ? 'size-6' : 'size-4.5'} />
      ) : (
        <AgentIcon agent={agentTypeToIconAgent(agent)} size={large ? 28 : 20} />
      )}
    </div>
  )
}
