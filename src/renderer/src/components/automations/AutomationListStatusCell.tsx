import React from 'react'
import { X } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function AutomationListStatusCell({ enabled }: { enabled: boolean }): React.JSX.Element {
  if (enabled) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 truncate text-muted-foreground">
        <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
        {translate('auto.components.automations.AutomationDetail.eaa02014f8', 'Enabled')}
      </span>
    )
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1 truncate text-muted-foreground">
      <X className="size-3.5 shrink-0" />
      {translate('auto.components.automations.AutomationDetail.b09b2384fd', 'Paused')}
    </span>
  )
}
