import React from 'react'
import { ExternalLink } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { GROK_TOP_UP_URL } from '../../../../../shared/agent-usage/grok-top-up-url'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'

/** Grok usage details plus a shortcut to grok.com billing, where credits are topped up. */
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
      <DropdownMenuItem onSelect={() => openAppHttpLink(GROK_TOP_UP_URL)}>
        {t('auto.components.status.bar.grok.topUp', 'Top up on grok.com')}
        <ExternalLink className="ml-auto size-3 text-muted-foreground" />
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
