import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type {
  OrcaBillingEntitlement,
  OrcaBillingOverageArgs
} from '../../../../shared/orca-billing'
import { formatDollars, formatHours, includedUsagePercent } from './plan-billing-format'

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
              value0: formatHours(entitlement.usedSeconds),
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
  const { overage } = entitlement
  const [capDollars, setCapDollars] = useState(String(Math.round(overage.spendCapCents / 100)))
  const parsedCap = Number(capDollars)
  const capValid = capDollars.trim() !== '' && Number.isInteger(parsedCap) && parsedCap >= 0
  const rate = formatDollars(overage.centsPerHour)
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
              { value0: rate, value1: formatDollars(overage.centsPerHour * 2) }
            )}
          </p>
        </div>
        <Switch
          checked={overage.optedIn}
          disabled={busy || !entitlement.canManageBilling}
          onCheckedChange={(enabled) => onSetOverage({ enabled })}
          aria-label={t('auto.components.billing.overageToggle', 'Allow overage')}
        />
      </div>
      {overage.optedIn ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.billing.overageSpent',
              '{{value0}} of {{value1}} monthly cap spent',
              {
                value0: formatDollars(overage.spentCents),
                value1: formatDollars(overage.spendCapCents)
              }
            )}
          </p>
          {entitlement.canManageBilling ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (capValid) {
                  onSetOverage({ enabled: true, spendCapCents: parsedCap * 100 })
                }
              }}
            >
              <span className="text-xs text-muted-foreground">
                {t('auto.components.billing.capLabel', 'Monthly cap ($)')}
              </span>
              <div className="w-24">
                <Input
                  inputMode="numeric"
                  value={capDollars}
                  onChange={(event) => setCapDollars(event.target.value)}
                  aria-label={t('auto.components.billing.capLabel', 'Monthly cap ($)')}
                />
              </div>
              <Button type="submit" size="sm" variant="outline" disabled={busy || !capValid}>
                {t('auto.components.billing.saveCap', 'Save')}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
