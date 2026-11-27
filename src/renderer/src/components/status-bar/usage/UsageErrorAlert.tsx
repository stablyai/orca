import { AlertTriangle } from 'lucide-react'
import React from 'react'
import type { Translate } from '@/i18n/use-translate'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getProviderDisplayName } from '../../../../../shared/agent-usage/display/usage-provider-windows'
import {
  getProviderUsageStatusLabel,
  isUsageWaitingForCli
} from '../../../../../shared/agent-usage/status-copy/usage-error-copy'
import { getTightestUsageSection } from './usage-headline-sections'

/** "<Provider>: <message>" for a chip that shows only the alert, else null. */
export function getUsageErrorAlertLabel(p: ProviderRateLimits, t: Translate): string | null {
  const name = getProviderDisplayName(p.provider)
  if (p.status === 'unavailable') {
    return `${name}: ${t('auto.components.status.bar.UsageRosterPanel.usageUnavailable', 'Usage unavailable')}`
  }
  if (p.status !== 'error' || isUsageWaitingForCli(p) || getTightestUsageSection(p, t, 'all')) {
    return null
  }
  return `${name}: ${getProviderUsageStatusLabel(p, t)}`
}

/**
 * Muted alert that replaces a chip's error text; a click falls through to the usage menu, whose rows
 * carry the message, and that menu's button describes every alert for screen readers.
 */
export function UsageErrorAlert({ label }: { label: string }): React.JSX.Element {
  return (
    <AlertTriangle
      size={14}
      role="img"
      aria-label={label}
      className="shrink-0 text-muted-foreground"
    />
  )
}
