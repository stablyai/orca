// The team's plan as it stands, above the plan cards: a plan with its hours and seats, the
// one-time trial, or (no plan) the trial terms billing's catalog offers.
import { Cloud, Gift } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import { PlanStatusBadge } from '../PlanStatusBadge'
import { formatHours, formatHoursUsed, includedUsagePercent } from '../plan-billing-format'
import {
  includedUsageTone,
  sandboxHoursCount,
  sandboxHoursLeftLine,
  trialHoursUsedLine
} from '../plan-billing-usage-copy'
import type { TrialPlanModel } from './plans-model'

const STRIP = 'space-y-2 rounded-xl border border-border bg-card p-4 shadow-xs'

export function CurrentPlanStrip({
  entitlement
}: {
  entitlement: OrcaBillingEntitlement
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const resets = entitlement.usageWindow
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(entitlement.usageWindow.end)
    : null
  return (
    <div className={STRIP}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{entitlement.planLabel}</span>
        <PlanStatusBadge entitlement={entitlement} />
      </div>
      <Progress
        value={includedUsagePercent(entitlement)}
        tone={includedUsageTone(entitlement)}
        aria-label={t('auto.components.billing.sandboxHoursUsedLabel', 'Sandbox hours used')}
      />
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span>
          {t(
            'auto.components.billing.sandboxHoursUsedMonth',
            '{{value0}} of {{value1}} sandbox hours used this month',
            {
              value0: formatHoursUsed(
                Math.min(entitlement.usedSeconds, entitlement.includedSeconds)
              ),
              value1: formatHours(entitlement.includedSeconds)
            }
          )}
        </span>
        <span>
          {resets
            ? t(
                'auto.components.billing.plans.sandboxHoursLeftResets',
                '{{count}} sandbox hours left · resets {{date}}',
                {
                  count: sandboxHoursCount(entitlement.remainingIncludedSeconds),
                  date: resets,
                  defaultValue_one: '{{count}} sandbox hour left · resets {{date}}'
                }
              )
            : sandboxHoursLeftLine(entitlement, t)}
        </span>
      </div>
    </div>
  )
}

export function TrialStrip({
  entitlement,
  canManage
}: {
  entitlement: OrcaBillingEntitlement
  canManage: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const usedUp = entitlement.trial?.exhausted === true
  return (
    <div className={STRIP}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Cloud className="size-4 text-muted-foreground" />
        <span className="font-medium">
          {t('auto.components.billing.trialProduct', 'Orca Cloud')}
        </span>
        <PlanStatusBadge entitlement={entitlement} />
      </div>
      <Progress
        value={includedUsagePercent(entitlement)}
        tone={usedUp ? 'warning' : includedUsageTone(entitlement)}
        aria-label={t('auto.components.billing.trialHoursUsedLabel', 'Trial sandbox hours used')}
      />
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs tabular-nums">
        <span className="font-medium">{trialHoursUsedLine(entitlement, t)}</span>
        <span className="text-muted-foreground">{sandboxHoursLeftLine(entitlement, t)}</span>
      </div>
      <p className="text-xs text-muted-foreground text-pretty">
        {usedUp
          ? canManage
            ? t(
                'auto.components.billing.plans.trialUsedUpAdmin',
                'Your trial hours are used up. Choose a plan to keep your sandboxes running.'
              )
            : t(
                'auto.components.billing.plans.trialUsedUpMember',
                'Your team’s trial hours are used up. Ask a team admin to upgrade.'
              )
          : t(
              'auto.components.billing.plans.trialOneTime2',
              'Trial hours are a one-time allowance and don’t reset. Choose a plan any time.'
            )}
      </p>
    </div>
  )
}

/** No plan and no trial yet: the trial billing's catalog offers (its own name and terms). */
export function TrialOfferStrip({ trial }: { trial: TrialPlanModel }): React.JSX.Element | null {
  if (trial.features.length === 0) {
    return null
  }
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Gift className="size-4" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{trial.tagline ?? trial.label}</p>
        <p className="text-xs leading-5 text-muted-foreground text-pretty">
          {trial.features.join(' · ')}
        </p>
      </div>
    </div>
  )
}
