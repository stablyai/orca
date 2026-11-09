import { useId, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type {
  OrcaBillingEntitlement,
  OrcaBillingOverageArgs
} from '../../../../shared/orca-billing'
import { formatHours, includedUsagePercent } from './plan-billing-format'
import { formatCents } from './plans/plans-pricing'

export function UsageSummary({
  entitlement
}: {
  entitlement: OrcaBillingEntitlement
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const date = (ms: number): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ms)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">
          {t(
            'auto.components.billing.hoursUsedMonth',
            '{{value0}} of {{value1}} hours used this month',
            {
              value0: formatHours(Math.min(entitlement.usedSeconds, entitlement.includedSeconds)),
              value1: formatHours(entitlement.includedSeconds)
            }
          )}
        </span>
        <span className="text-muted-foreground">
          {t('auto.components.billing.hoursLeft', '{{value0}} hours left', {
            value0: formatHours(entitlement.remainingIncludedSeconds)
          })}
        </span>
      </div>
      <Progress
        value={includedUsagePercent(entitlement)}
        aria-label={t('auto.components.billing.usageLabel', 'Included hours used')}
      />
      {entitlement.overageSeconds > 0 ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t(
            'auto.components.billing.overageHours',
            '{{value0}} overage hours · {{value1}} of {{value2}} cap',
            {
              value0: formatHours(entitlement.overageSeconds),
              value1: formatCents(entitlement.overage.spentCents, locale),
              value2: formatCents(entitlement.overage.spendCapCents, locale)
            }
          )}
        </p>
      ) : null}
      {entitlement.usageWarningPercent !== null ? (
        <p className="text-xs font-medium">
          {entitlement.usageWarningPercent >= 100
            ? t('auto.components.billing.warn100', 'All included hours for this month are used.')
            : t(
                'auto.components.billing.warnPercent',
                'You have used {{value0}}% of this month’s included hours.',
                {
                  value0: String(entitlement.usageWarningPercent)
                }
              )}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {entitlement.usageWindow
          ? t('auto.components.billing.resets', 'Hours reset {{value0}}', {
              value0: date(entitlement.usageWindow.end)
            })
          : null}
        {entitlement.period
          ? ` · ${
              entitlement.cancelAtPeriodEnd
                ? t('auto.components.billing.endsOn', 'Plan ends {{value0}}', {
                    value0: date(entitlement.period.end)
                  })
                : t('auto.components.billing.renewsOn', 'Renews {{value0}}', {
                    value0: date(entitlement.period.end)
                  })
            }`
          : null}
      </p>
    </div>
  )
}

export function OverageControls({
  entitlement,
  busy,
  onSetOverage
}: {
  entitlement: OrcaBillingEntitlement
  busy: boolean
  onSetOverage: (args: OrcaBillingOverageArgs) => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const capId = useId()
  const { overage } = entitlement
  const savedDollars = String(Math.round(overage.spendCapCents / 100))
  const [capDollars, setCapDollars] = useState(savedDollars)
  // Shows "Saved" after a successful cap change until the field is edited again (review M13).
  const [savedFlash, setSavedFlash] = useState(false)
  // Re-seed the field when the saved cap changes (render-time adjustment, no effect).
  const [seededFrom, setSeededFrom] = useState(savedDollars)
  if (seededFrom !== savedDollars) {
    setSeededFrom(savedDollars)
    setCapDollars(savedDollars)
  }
  const parsedCap = Number(capDollars)
  const capValid = capDollars.trim() !== '' && Number.isInteger(parsedCap) && parsedCap >= 0
  const changed = capValid && capDollars.trim() !== savedDollars
  const largeWeight = entitlement.offers?.team.largeMachineWeight ?? 2
  const suspended = entitlement.payment.suspendRunning || entitlement.payment.pastDueSince !== null
  const canEdit = entitlement.canManageBilling && !suspended
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t('auto.components.billing.overageTitle', 'Overage')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.billing.overageDescription',
              'Keep starting sandboxes after included hours at {{value0}}/hr Standard ({{value1}}/hr Large).',
              {
                value0: formatCents(overage.centsPerHour, locale),
                value1: formatCents(Math.round(overage.centsPerHour * largeWeight), locale)
              }
            )}
          </p>
        </div>
        <Switch
          checked={overage.optedIn}
          disabled={busy || !canEdit}
          onCheckedChange={(enabled) => onSetOverage({ enabled })}
          aria-label={t('auto.components.billing.overageToggle', 'Allow overage')}
        />
      </div>
      {overage.optedIn ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground tabular-nums">
            {t(
              'auto.components.billing.overageSpent',
              '{{value0}} of {{value1}} monthly cap spent',
              {
                value0: formatCents(overage.spentCents, locale),
                value1: formatCents(overage.spendCapCents, locale)
              }
            )}
          </p>
          {canEdit ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (changed) {
                  onSetOverage({ enabled: true, spendCapCents: parsedCap * 100 })
                  setSavedFlash(true)
                }
              }}
            >
              <label htmlFor={capId} className="text-xs font-medium">
                {t('auto.components.billing.capLabel2', 'Monthly spend cap')}
              </label>
              <div className="relative w-28">
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground"
                >
                  $
                </span>
                <Input
                  id={capId}
                  inputMode="numeric"
                  className="pl-6 tabular-nums"
                  value={capDollars}
                  aria-invalid={!capValid || undefined}
                  onChange={(event) => {
                    setCapDollars(event.target.value)
                    setSavedFlash(false)
                  }}
                />
              </div>
              {changed ? (
                <Button type="submit" size="sm" variant="outline" disabled={busy}>
                  {t('auto.components.billing.saveCap', 'Save')}
                </Button>
              ) : savedFlash && !busy ? (
                <span
                  role="status"
                  className="flex items-center gap-1 text-xs text-muted-foreground"
                >
                  <Check className="size-3.5" />
                  {t('auto.components.billing.capSaved', 'Saved')}
                </span>
              ) : null}
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
