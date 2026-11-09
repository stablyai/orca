import { useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsDisabledControlTooltip } from '@/components/settings/form-controls/SettingsDisabledControlTooltip'
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

/** "Resets and renews Dec 2" when both land the same day (monthly); separate parts otherwise. */
function resetLine(
  entitlement: OrcaBillingEntitlement,
  date: (ms: number) => string,
  t: ReturnType<typeof useTranslate>
): string | null {
  const resets = entitlement.usageWindow ? date(entitlement.usageWindow.end) : null
  const ends = entitlement.period ? date(entitlement.period.end) : null
  if (ends && entitlement.cancelAtPeriodEnd) {
    return resets
      ? t('auto.components.billing.resetsEnds', 'Hours reset {{value0}} · Plan ends {{value1}}', {
          value0: resets,
          value1: ends
        })
      : t('auto.components.billing.endsOn', 'Plan ends {{value0}}', { value0: ends })
  }
  if (resets && ends) {
    return resets === ends
      ? t('auto.components.billing.resetsAndRenews', 'Resets and renews {{value0}}', {
          value0: ends
        })
      : t('auto.components.billing.resetsRenews', 'Hours reset {{value0}} · Renews {{value1}}', {
          value0: resets,
          value1: ends
        })
  }
  if (resets) {
    return t('auto.components.billing.resets', 'Hours reset {{value0}}', { value0: resets })
  }
  return ends ? t('auto.components.billing.renewsOn', 'Renews {{value0}}', { value0: ends }) : null
}

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
            'auto.components.billing.sandboxHoursUsedMonth',
            '{{value0}} of {{value1}} sandbox hours used this month',
            {
              value0: formatHours(Math.min(entitlement.usedSeconds, entitlement.includedSeconds)),
              value1: formatHours(entitlement.includedSeconds)
            }
          )}
        </span>
        <span className="text-muted-foreground">
          {t('auto.components.billing.sandboxHoursLeft', '{{value0}} sandbox hours left', {
            value0: formatHours(entitlement.remainingIncludedSeconds)
          })}
        </span>
      </div>
      <Progress
        value={includedUsagePercent(entitlement)}
        aria-label={t('auto.components.billing.usageLabel', 'Included hours used')}
      />
      {entitlement.overageSeconds === 0 &&
      entitlement.usedSeconds > entitlement.includedSeconds &&
      entitlement.includedSeconds > 0 ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('auto.components.billing.overBy', 'Over by {{value0}} h this month', {
            value0: formatHours(entitlement.usedSeconds - entitlement.includedSeconds)
          })}
        </p>
      ) : null}
      {entitlement.overageSeconds > 0 ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('auto.components.billing.overageHoursOnly', '{{value0}} overage hours this month', {
            value0: formatHours(entitlement.overageSeconds)
          })}
        </p>
      ) : null}
      {entitlement.usageWarningPercent !== null && entitlement.usageWarningPercent < 100 ? (
        <p className="text-xs font-medium">
          {entitlement.usageWarningPercent >= 100
            ? t('auto.components.billing.warn100b', 'All of this month’s sandbox hours are used.')
            : t(
                'auto.components.billing.warnPercent2',
                'You’ve used {{value0}}% of this month’s sandbox hours.',
                {
                  value0: String(entitlement.usageWarningPercent)
                }
              )}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{resetLine(entitlement, date, t)}</p>
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
  const descriptionId = useId()
  const capErrorId = useId()
  const savedRef = useRef<HTMLSpanElement>(null)
  const { overage } = entitlement
  const savedDollars = String(Math.round(overage.spendCapCents / 100))
  const [capDollars, setCapDollars] = useState(savedDollars)
  // Shows "Saved" after a successful cap change until the field is edited again (review M13).
  const [savedFlash, setSavedFlash] = useState(false)
  // The switch flips at once; the saved value takes over when billing answers.
  const [optimisticOn, setOptimisticOn] = useState<boolean | null>(null)
  // Re-seed from the server whenever the saved values change (render-time adjustment, no effect).
  const [seededFrom, setSeededFrom] = useState(`${savedDollars}:${overage.optedIn}`)
  if (seededFrom !== `${savedDollars}:${overage.optedIn}`) {
    setSeededFrom(`${savedDollars}:${overage.optedIn}`)
    setCapDollars(savedDollars)
    setOptimisticOn(null)
  }
  const optedIn = optimisticOn ?? overage.optedIn
  const parsedCap = Number(capDollars)
  const capValid = capDollars.trim() !== '' && Number.isInteger(parsedCap) && parsedCap >= 0
  const changed = capValid && capDollars.trim() !== savedDollars
  const largeWeight = entitlement.offers?.team.largeMachineWeight ?? 2
  const paymentFailed = entitlement.payment.pastDueSince !== null
  const description = t(
    'auto.components.billing.overageDescription4',
    'Optional overage at {{value0}}/hour ({{value1}}/hour on Large), up to a monthly spend cap you set ({{value2}} by default).',
    {
      value0: formatCents(overage.centsPerHour, locale),
      value1: formatCents(Math.round(overage.centsPerHour * largeWeight), locale),
      value2: formatCents(entitlement.offers?.team.defaultSpendCapCents ?? 2500, locale)
    }
  )
  const capPercent =
    overage.spendCapCents > 0
      ? Math.min(100, Math.round((overage.spentCents / overage.spendCapCents) * 100))
      : 0
  const spent = (
    <div className="space-y-1.5">
      <Progress
        value={capPercent}
        aria-label={t('auto.components.billing.capUsedLabel', 'Overage spend cap used')}
      />
      <p className="text-xs text-muted-foreground tabular-nums">
        {t('auto.components.billing.overageSpent', '{{value0}} of {{value1}} monthly cap spent', {
          value0: formatCents(overage.spentCents, locale),
          value1: formatCents(overage.spendCapCents, locale)
        })}
      </p>
    </div>
  )

  // Members see the setting as plain text: a switch they can't use only invites clicks.
  if (!entitlement.canManageBilling) {
    return (
      <div className="space-y-2 rounded-md border border-border/60 p-3">
        <p className="text-sm">
          <span className="font-medium">
            {t('auto.components.billing.overageTitle', 'Overage')}
          </span>
          <span className="text-muted-foreground">
            {' · '}
            {overage.optedIn
              ? t('auto.components.billing.overageOnRead', 'On')
              : t('auto.components.billing.overageOffRead', 'Off')}
          </span>
        </p>
        {overage.optedIn ? spent : null}
        <p className="text-xs text-muted-foreground">
          {t('auto.components.billing.overageMemberHint', 'Owners and admins can change overage.')}
        </p>
      </div>
    )
  }

  const toggleBlocked = busy || paymentFailed
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t('auto.components.billing.overageTitle', 'Overage')}
          </p>
          <p id={descriptionId} className="text-xs text-muted-foreground">
            {description}
          </p>
        </div>
        <SettingsDisabledControlTooltip
          reason={
            paymentFailed
              ? t(
                  'auto.components.billing.overagePaymentFailed',
                  'Update the payment method before changing overage.'
                )
              : undefined
          }
        >
          <Switch
            checked={optedIn}
            // aria-disabled keeps focus on the switch while a change saves.
            aria-disabled={toggleBlocked || undefined}
            aria-describedby={descriptionId}
            onCheckedChange={(enabled) => {
              if (toggleBlocked) {
                return
              }
              setOptimisticOn(enabled)
              onSetOverage({ enabled })
            }}
            aria-label={t('auto.components.billing.overageToggle', 'Allow overage')}
          />
        </SettingsDisabledControlTooltip>
      </div>
      {optedIn ? (
        <div className="space-y-3">
          {spent}
          {paymentFailed ? null : (
            <form
              className="flex flex-wrap items-start gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (changed && !busy) {
                  onSetOverage({ enabled: true, spendCapCents: parsedCap * 100 })
                  setSavedFlash(true)
                  // Save unmounts; land focus on the confirmation instead of the page body.
                  window.requestAnimationFrame(() => savedRef.current?.focus())
                }
              }}
            >
              <label htmlFor={capId} className="flex h-9 items-center text-xs font-medium">
                {t('auto.components.billing.capLabel2', 'Monthly spend cap')}
              </label>
              <div className="space-y-1">
                <div className="flex w-32 items-center gap-1.5">
                  <span aria-hidden className="text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    id={capId}
                    inputMode="numeric"
                    value={capDollars}
                    aria-invalid={!capValid || undefined}
                    aria-describedby={capValid ? undefined : capErrorId}
                    onChange={(event) => {
                      setCapDollars(event.target.value)
                      setSavedFlash(false)
                    }}
                  />
                </div>
                {capValid && entitlement.reason === 'overage_cap_reached' ? (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'auto.components.billing.capReachedHint',
                      'Raise the cap to keep starting sandboxes. Your files are safe.'
                    )}
                  </p>
                ) : null}
                {capValid ? null : (
                  <p id={capErrorId} className="text-xs text-destructive">
                    {t('auto.components.billing.capInvalid', 'Enter a whole dollar amount.')}
                  </p>
                )}
              </div>
              {changed ? (
                <Button type="submit" variant="outline" aria-disabled={busy || undefined}>
                  {t('auto.components.billing.saveCap', 'Save')}
                </Button>
              ) : savedFlash ? (
                <span
                  ref={savedRef}
                  tabIndex={-1}
                  role="status"
                  className="flex h-9 items-center gap-1 text-xs text-muted-foreground outline-none"
                >
                  <Check className="size-3.5" />
                  {busy
                    ? t('auto.components.billing.capSaving', 'Saving…')
                    : t('auto.components.billing.capSaved', 'Saved')}
                </span>
              ) : null}
            </form>
          )}
        </div>
      ) : null}
    </div>
  )
}
