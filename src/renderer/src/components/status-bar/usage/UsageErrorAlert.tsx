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
import { getUsageRosterRowState } from './usage-roster-row-state'

/** "<Provider>: <message>" for a chip whose message lives only in the usage menu (alert or "--"), else null. */
export function getUsageChipDescription(p: ProviderRateLimits, t: Translate): string | null {
  const describe =
    p.status === 'unavailable' ||
    (p.status === 'error' && !isUsageWaitingForCli(p) && !getTightestUsageSection(p, t, 'all'))
  if (!describe) {
    return null
  }
  // Why the row's label: the menu row is where the message is read, so the description must match it.
  const message =
    getUsageRosterRowState(p, false, t).statusLabel ?? getProviderUsageStatusLabel(p, t)
  return `${getProviderDisplayName(p.provider)}: ${message}`
}

/**
 * Muted alert that replaces a chip's error text (real failures only; other states show "--"); a click falls through to the usage menu, whose rows
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
