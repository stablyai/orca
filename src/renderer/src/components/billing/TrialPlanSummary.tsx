// The team's one-time trial (spec T1) in Plan & billing and on the plans page: a "Trial" badge,
// the hours bar, and the one-time-allowance line. Never "Hours reset every month" here.
import { Cloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { includedUsagePercent } from './plan-billing-format'
import { denyReasonCopy } from './plan-billing-copy'
import {
  includedUsageTone,
  sandboxHoursLeftLine,
  trialHoursUsedLine
} from './plan-billing-usage-copy'
import { PlanStatusBadge } from './PlanStatusBadge'

export function TrialPlanSummary({
  entitlement,
  onChoosePlan
}: {
  entitlement: OrcaBillingEntitlement
  /** Shown to owners and admins; omitted where the plan cards are already on screen. */
  onChoosePlan?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const usedUp = entitlement.trial?.exhausted === true
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Cloud className="size-4 text-muted-foreground" />
        <p className="text-sm font-medium">
          {t('auto.components.billing.trialProduct', 'Orca Cloud')}
        </p>
        <PlanStatusBadge entitlement={entitlement} />
      </div>
      <div className="space-y-2">
        <Progress
          value={includedUsagePercent(entitlement)}
          tone={usedUp ? 'warning' : includedUsageTone(entitlement)}
          aria-label={t('auto.components.billing.trialHoursUsedLabel', 'Trial sandbox hours used')}
        />
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs tabular-nums">
          <span className="font-medium">{trialHoursUsedLine(entitlement, t)}</span>
          <span className="text-muted-foreground">{sandboxHoursLeftLine(entitlement, t)}</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground text-pretty">
        {usedUp
          ? denyReasonCopy('trial_used_up', t, entitlement.canManageBilling)
          : t(
              'auto.components.billing.trialOneTime',
              'Trial hours are a one-time allowance and don’t reset. When they’re used up, choose a plan to keep going. No card needed until then.'
            )}
      </p>
      {onChoosePlan && entitlement.canManageBilling ? (
        <Button
          type="button"
          variant={usedUp ? 'default' : 'outline'}
          size="sm"
          onClick={onChoosePlan}
        >
          {t('auto.components.billing.choosePlan', 'Choose plan')}
        </Button>
      ) : null}
    </div>
  )
}
