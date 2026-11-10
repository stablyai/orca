// The build sheet's "Trial · 2 sandbox hours left" chip (A7, O4): which hours this start spends.
import React from 'react'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useOrcaCloudRunTargetAccess } from '../orca-cloud-billing-cache'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import { getOrcaCloudHoursChip } from './orca-cloud-hours-copy'

export function OrcaCloudHoursChip({
  enabled,
  accessOverride
}: {
  enabled: boolean
  /** Fixtures pin the account's access. */
  accessOverride?: OrcaCloudRunTargetAccess
}): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  const fetched = useOrcaCloudRunTargetAccess(enabled && !accessOverride)
  const access = accessOverride ?? fetched
  const label = enabled ? getOrcaCloudHoursChip(access, t, locale) : null
  if (!label) {
    return null
  }
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-2xs tabular-nums text-muted-foreground">
      {label}
    </span>
  )
}
