import { AlertTriangle } from 'lucide-react'
import { Badge } from '../ui/badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AgentCatalogRowStatus } from './agent-catalog-rows'

/** Localized single-word-ish effective-status label (plan §971). Pure so it can
 *  double as an accessible name without rendering the badge. */
export function agentCatalogStatusLabel(status: AgentCatalogRowStatus): string {
  switch (status) {
    case 'enabled':
      return translate('auto.components.settings.AgentCatalogStatusBadge.enabled', 'Enabled')
    case 'disabled':
      return translate('auto.components.settings.AgentCatalogStatusBadge.disabled', 'Disabled')
    case 'base-disabled':
      return translate(
        'auto.components.settings.AgentCatalogStatusBadge.baseDisabled',
        'Base disabled'
      )
    case 'not-installed':
      return translate(
        'auto.components.settings.AgentCatalogStatusBadge.notInstalled',
        'Not installed'
      )
    case 'custom-executable':
      return translate(
        'auto.components.settings.AgentCatalogStatusBadge.customExecutable',
        'Custom executable'
      )
    case 'custom-path':
      return translate('auto.components.settings.AgentCatalogStatusBadge.customPath', 'Custom PATH')
    case 'repair-required':
      return translate(
        'auto.components.settings.AgentCatalogStatusBadge.repairRequired',
        'Repair required'
      )
  }
}

type BadgeVariant = React.ComponentProps<typeof Badge>['variant']

function statusVariant(status: AgentCatalogRowStatus): BadgeVariant {
  switch (status) {
    case 'enabled':
      return 'secondary'
    case 'custom-executable':
    case 'custom-path':
      return 'outline'
    case 'base-disabled':
    case 'disabled':
    case 'not-installed':
    case 'repair-required':
      // Disabled/base-disabled/not-installed/repair read as quiet, non-primary.
      return 'ghost'
  }
}

export function AgentCatalogStatusBadge({
  status
}: {
  status: AgentCatalogRowStatus
}): React.JSX.Element {
  const label = agentCatalogStatusLabel(status)
  const isRepair = status === 'repair-required'
  return (
    <Badge
      variant={statusVariant(status)}
      className={cn(
        'font-normal',
        isRepair && 'border-warning/40 text-warning-text',
        status === 'not-installed' && 'text-muted-foreground'
      )}
    >
      {isRepair ? <AlertTriangle className="size-3" /> : null}
      {label}
    </Badge>
  )
}
