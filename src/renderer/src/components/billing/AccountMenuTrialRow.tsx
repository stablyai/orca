// Account menu row while the team is on its one-time trial (spec T1): "Trial · 1.4 sandbox hours
// left", visible to every member; owners and admins can pick it to choose a plan. It disappears
// once a plan starts, because the entitlement no longer carries a trial.
import { Cloud } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import { accountMenuTrialRow } from './plan-billing-usage-copy'
import { openPlansPage } from './plans/plans-page-store'

export function AccountMenuTrialRow({
  result
}: {
  result: OrcaBillingStatusResult | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const row = accountMenuTrialRow(result, t)
  if (!row) {
    return null
  }
  const label = (
    <span
      className={cn('min-w-0 tabular-nums text-pretty', row.usedUp && 'text-status-warning-text')}
    >
      {row.label}
    </span>
  )
  return (
    <>
      {row.canChoosePlan ? (
        <DropdownMenuItem
          data-account-menu-trial=""
          onSelect={() => openPlansPage('account-menu')}
          aria-label={t('auto.components.billing.trialRowChoosePlan', '{{trial}}. Choose plan', {
            trial: row.label
          })}
        >
          <Cloud className="size-3.5 self-start mt-0.5" />
          {/* Two lines in the 240px menu: the hours never truncate (spec T1). */}
          <span className="flex min-w-0 flex-col gap-0.5">
            {label}
            <span className="text-xs text-muted-foreground">
              {t('auto.components.billing.choosePlan', 'Choose plan')}
            </span>
          </span>
        </DropdownMenuItem>
      ) : (
        <DropdownMenuLabel variant="hint" data-account-menu-trial="">
          <span className="flex items-center gap-2">
            <Cloud className="size-3.5 shrink-0" />
            {label}
          </span>
        </DropdownMenuLabel>
      )}
      <DropdownMenuSeparator />
    </>
  )
}
