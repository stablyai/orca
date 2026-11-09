import React from 'react'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { getOrcaCloudDetail } from './run-target-options'
import {
  formatOrcaCloudHoursLeft,
  useOrcaCloudRunTargetAccess,
  type OrcaCloudRunTargetAccess
} from './orca-cloud-run-target-access'

/**
 * Machine and hours context under Run on once Orca Cloud is the committed target. A selection made
 * before billing answered (or restored from a draft) surfaces its block here instead of at Create.
 */
export function OrcaCloudSelectionHint({
  access: accessOverride
}: {
  /** Fixtures pin the entitlement; otherwise it is read from billing while mounted. */
  access?: OrcaCloudRunTargetAccess
}): React.JSX.Element {
  const t = useTranslate()
  const fetched = useOrcaCloudRunTargetAccess(!accessOverride)
  const access = accessOverride ?? fetched
  const status = ((): string | null => {
    switch (access.state) {
      case 'entitled':
        return t(
          'auto.components.new.workspace.RunTargetCombobox.orcaCloudHoursLeft',
          '{{hours}} h left',
          {
            hours: formatOrcaCloudHoursLeft(access.remainingSeconds)
          }
        )
      case 'no-plan':
        return t(
          'auto.components.new.workspace.RunTargetCombobox.orcaCloudNeedsTeam',
          'Needs a Team plan'
        )
      case 'out-of-hours':
        return t(
          'auto.components.new.workspace.RunTargetCombobox.orcaCloudNoHours',
          'No hours left'
        )
      case 'payment-issue':
        return t(
          'auto.components.new.workspace.RunTargetCombobox.orcaCloudPaymentFailed',
          'Payment failed'
        )
      default:
        return null
    }
  })()
  const blocked =
    access.state === 'no-plan' ||
    access.state === 'out-of-hours' ||
    access.state === 'payment-issue'
  return (
    <p
      role={blocked ? 'status' : undefined}
      className={cn(
        'text-2xs tabular-nums',
        blocked ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {status ? `${getOrcaCloudDetail(t)} · ${status}` : getOrcaCloudDetail(t)}
    </p>
  )
}
