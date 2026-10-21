import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  getAgentCapabilityStatusClassName,
  type AgentCapabilityInstallStatus
} from './agent-capability-setup-status'

// Why: pills sit top-right so they line up across cards regardless of description length.
export function AgentCapabilityStatusPill(props: {
  status: AgentCapabilityInstallStatus
}): React.JSX.Element | null {
  if (props.status.tone === 'unavailable') {
    return (
      <span className="text-[11px] font-medium text-muted-foreground">{props.status.label}</span>
    )
  }
  if (!props.status.installed) {
    return null
  }
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
      <Check className="size-3" />
      {translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.b8dc9dd8a2',
        'Installed'
      )}
    </span>
  )
}

/** Secondary status text (checking, errors, pending actions); installed/unavailable live in the pill. */
export function AgentCapabilityStatusNote(props: {
  status: AgentCapabilityInstallStatus
}): React.JSX.Element | null {
  if (props.status.tone === 'ready' || props.status.tone === 'unavailable') {
    return null
  }
  return (
    <span
      className={cn(
        'mt-2 text-xs font-medium',
        getAgentCapabilityStatusClassName(props.status.tone)
      )}
    >
      {props.status.label}
    </span>
  )
}
