import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getAgentCapabilityStatusClassName,
  type AgentCapabilityInstallStatus
} from './agent-capability-setup-status'

// Why: mt-auto pins every card's status to the bottom edge so they line up across the row.
export function AgentCapabilityStatusNote(props: {
  status: AgentCapabilityInstallStatus
}): React.JSX.Element | null {
  if (!props.status.label) {
    return null
  }
  return (
    <span
      className={cn(
        'mt-auto flex items-center gap-1 pt-2 text-xs font-medium',
        getAgentCapabilityStatusClassName(props.status.tone)
      )}
    >
      {props.status.tone === 'ready' ? <Check className="size-3 shrink-0" /> : null}
      {props.status.label}
    </span>
  )
}
