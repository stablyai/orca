import React from 'react'
import { ExternalLink } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { openGrokBillingPage } from './grok-billing-page'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'

/** Grok usage details plus a shortcut to the grok.com billing page. */
export function GrokUsageMenu({
  grok,
  compact,
  triggerContent
}: {
  grok: ProviderRateLimits
  compact: boolean
  triggerContent: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ProviderDetailsMenu
      provider={grok}
      compact={compact}
      iconOnly={false}
      asSubmenu
      triggerContent={triggerContent}
      ariaLabel={t('auto.components.status.bar.UsageRosterPanel.openDetails', 'Open usage details')}
    >
      <DropdownMenuItem onSelect={openGrokBillingPage}>
        {t('auto.components.status.bar.grok.openBilling', 'Open Grok billing')}
        <ExternalLink className="ml-auto size-3 text-muted-foreground" />
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
