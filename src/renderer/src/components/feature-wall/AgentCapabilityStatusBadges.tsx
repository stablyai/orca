import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getAgentCapabilityStatusClassName,
  type AgentCapabilityInstallStatus
} from './agent-capability-setup-status'

export function AgentCapabilityStatusNote(props: {
  status: AgentCapabilityInstallStatus
}): React.JSX.Element | null {
  if (!props.status.label) {
    return null
  }
  return (
    <span
      className={cn(
        'mt-auto flex min-w-0 items-center gap-1 pt-2 text-xs font-medium',
        getAgentCapabilityStatusClassName(props.status.tone)
      )}
    >
      {props.status.tone === 'ready' ? <Check className="size-3 shrink-0" /> : null}
      <span className="min-w-0 truncate">{props.status.label}</span>
    </span>
  )
}
