import { useAutomationHostCatalog } from '../automations/use-automation-host-catalog'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'

export function AutomationFailureBadge() {
  const { unseenFailureCount } = useAutomationHostCatalog({ failureCountOnly: true })
  return unseenFailureCount > 0 ? (
    <Badge
      variant="destructive"
      aria-label={translate('automations.unseenFailures', '{{count}} unseen failed runs', {
        count: unseenFailureCount
      })}
    >
      {unseenFailureCount}
    </Badge>
  ) : null
}
