import { useEffect, useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsDisabledControlTooltip } from '@/components/settings/form-controls/SettingsDisabledControlTooltip'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type {
  OrcaBillingEntitlement,
  OrcaBillingOverageArgs
} from '../../../../shared/orca-billing'
import { formatHours, formatHoursUsed, includedUsagePercent } from './plan-billing-format'
import {
  includedUsageTone,
  sandboxHoursLeftLine,
  sandboxHoursOverLine,
  usageWarningLine
} from './plan-billing-usage-copy'
import { formatCents, formatRateCents } from './plans/plans-pricing'
import { capTooHighCopy } from './plan-billing-copy'
import { ORCA_BILLING_OVERAGE_SECTION_ID } from '../new-workspace/orca-cloud-run-target-access'

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
      : t('auto.components.billing.endsOn', 'Plan ends {{value0}}', {
          value0: ends
        })
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
    return t('auto.components.billing.resets', 'Hours reset {{value0}}', {
      value0: resets
    })
  }
  return ends
    ? t('auto.components.billing.renewsOn', 'Renews {{value0}}', {
        value0: ends
      })
    : null
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
  const overLine = sandboxHoursOverLine(entitlement, t)
  const warning = usageWarningLine(entitlement, t, locale)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">
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
        <span className="text-muted-foreground">{sandboxHoursLeftLine(entitlement, t)}</span>
      </div>
      <Progress
        value={includedUsagePercent(entitlement)}
        tone={includedUsageTone(entitlement)}
        aria-label={t('auto.components.billing.sandboxHoursUsedLabel', 'Sandbox hours used')}
      />
      {overLine ? <p className="text-xs text-muted-foreground tabular-nums">{overLine}</p> : null}
      {warning ? <p className="text-xs font-medium">{warning}</p> : null}
      <p className="text-xs text-muted-foreground">{resetLine(entitlement, date, t)}</p>
    </div>
  )
}

export function OverageControls({
  entitlement,
  busy,
  failures = 0,
  onSetOverage
}: {
  entitlement: OrcaBillingEntitlement
  busy: boolean
  /** Bumped by the parent each time a change fails, to roll back the optimistic state. */
  failures?: number
  onSetOverage: (args: OrcaBillingOverageArgs) => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const capId = useId()
  const hintId = useId()
  const capErrorId = useId()
  const savedRef = useRef<HTMLSpanElement>(null)
  const capInputRef = useRef<HTMLInputElement>(null)
  // Set by Turn on: once the cap field appears, it takes focus (N-09).
  const focusCapOnOpen = useRef(false)
  const { overage } = entitlement
  useEffect(() => {
    if (overage.optedIn && focusCapOnOpen.current) {
      focusCapOnOpen.current = false
      capInputRef.current?.focus()
    }
  }, [overage.optedIn])
  // One field: the cap while overage is on, $0 while it's off.
  const savedDollars = overage.optedIn ? String(Math.round(overage.spendCapCents / 100)) : '0'
  const defaultCapCents = entitlement.offers?.team.defaultSpendCapCents ?? 2500
  const [capDollars, setCapDollars] = useState(savedDollars)
  // Shows "Saved" after a successful change until the field is edited again (review M13).
  const [savedFlash, setSavedFlash] = useState(false)
  // Re-seed from the server whenever the saved values change (render-time adjustment, no effect).
  const [seededFrom, setSeededFrom] = useState(savedDollars)
  if (seededFrom !== savedDollars) {
    setSeededFrom(savedDollars)
    setCapDollars(savedDollars)
  }
  const [seenFailures, setSeenFailures] = useState(failures)
  if (seenFailures !== failures) {
    setSeenFailures(failures)
    setCapDollars(savedDollars)
    setSavedFlash(false)
  }
  const parsedCap = Number(capDollars)
  const maxCapCents = entitlement.offers?.team.maxSpendCapCents ?? null
  const capWhole = capDollars.trim() !== '' && Number.isInteger(parsedCap) && parsedCap >= 0
  // N-09: "off" has one representation (the Turn on button); a saved $0 cap would read as "on".
  const capZero = capWhole && parsedCap === 0
  const capTooHigh = capWhole && maxCapCents !== null && parsedCap * 100 > maxCapCents
  const capValid = capWhole && !capTooHigh && !capZero
  const changed = capValid && capDollars.trim() !== savedDollars
  const paymentFailed = entitlement.payment.pastDueSince !== null
  const rate = formatRateCents(overage.centsPerHour, locale)
  const hint = t(
    'components.billing.overage.capHint2',
    '{{rate}} per sandbox hour after your included hours, billed by the minute.',
    { rate }
  )
  const capPercent =
    overage.spendCapCents > 0
      ? Math.min(100, Math.round((overage.spentCents / overage.spendCapCents) * 100))
      : 0
  const spent = (
    <div className="space-y-1.5">
      <Progress
        value={capPercent}
        tone={capPercent >= 100 ? 'warning' : 'default'}
        aria-label={t('auto.components.billing.capUsedLabel', 'Overage spend cap used')}
      />
      <p className="text-xs text-muted-foreground tabular-nums">
        {t('components.billing.overageUsed', '{{value0}} of {{value1}} used', {
          value0: formatCents(overage.spentCents, locale),
          value1: formatCents(overage.spendCapCents, locale)
        })}
      </p>
    </div>
  )
  const title = (
    <p className="text-sm font-medium">{t('auto.components.billing.overageTitle', 'Overage')}</p>
  )

  // Members see the setting as plain text: a field they can't use only invites clicks.
  if (!entitlement.canManageBilling) {
    return (
      <div className="space-y-2 rounded-md border border-border/60 p-3">
        {title}
        <p className="text-xs text-muted-foreground tabular-nums">
          {overage.optedIn
            ? t(
                'components.billing.overage.memberOn3',
                'Overage is on, up to {{cap}} a month. Ask an owner or admin to change this.',
                { cap: formatCents(overage.spendCapCents, locale) }
              )
            : t(
                'components.billing.overage.memberOff3',
                'Overage is off. Work stops when sandbox hours run out. Ask an owner or admin to change this.'
              )}
        </p>
        {overage.optedIn ? spent : null}
      </div>
    )
  }

  const save = (enabled: boolean, cents: number): void => {
    onSetOverage(enabled ? { enabled: true, spendCapCents: cents } : { enabled: false })
    setSavedFlash(true)
    // The action turns into "Saving…" in place; move focus onto it.
    window.requestAnimationFrame(() => savedRef.current?.focus())
  }
  const blockedReason = paymentFailed
    ? t(
        'auto.components.billing.overagePaymentFailed',
        'Update the payment method before changing overage.'
      )
    : undefined
  const alertsNote = (
    <p className="text-xs text-muted-foreground">
      {t(
        'auto.components.billing.usageAlertsNote',
        'Owners and admins are alerted in Orca at 75%, 90% and 100% of your team’s sandbox hours.'
      )}
    </p>
  )
  const turnOn = (): void => {
    if (busy) {
      return
    }
    setCapDollars(String(Math.round(defaultCapCents / 100)))
    focusCapOnOpen.current = true
    save(true, defaultCapCents)
  }

  // N-09: off is one status line and one action. No cap field and no "$ 0" (which reads as "on").
  if (!overage.optedIn) {
    return (
      <div
        id={ORCA_BILLING_OVERAGE_SECTION_ID}
        className="space-y-3 rounded-md border border-border/60 p-3"
      >
        {title}
        <p className="text-xs text-muted-foreground">
          {t(
            'components.billing.overage.offStatus',
            'Overage is off. Work stops when sandbox hours run out.'
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {savedFlash ? (
            <span
              ref={savedRef}
              tabIndex={-1}
              role="status"
              className="flex h-9 items-center gap-1 text-xs text-muted-foreground outline-none"
            >
              <Check className="size-3.5" />
              {t('auto.components.billing.capSaving', 'Saving…')}
            </span>
          ) : (
            <SettingsDisabledControlTooltip reason={blockedReason}>
              <Button
                type="button"
                variant="outline"
                aria-disabled={busy || paymentFailed || undefined}
                onClick={paymentFailed ? undefined : turnOn}
              >
                {t('auto.components.billing.overage.turnOn', 'Turn on with a {{cap}} cap', {
                  cap: formatCents(defaultCapCents, locale)
                })}
              </Button>
            </SettingsDisabledControlTooltip>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {alertsNote}
      </div>
    )
  }

  return (
    // Deep-link target: the Run-on picker's "Turn on overage" / "Raise cap" lands here.
    <div
      id={ORCA_BILLING_OVERAGE_SECTION_ID}
      className="space-y-3 rounded-md border border-border/60 p-3"
    >
      {title}
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (changed && !busy && !paymentFailed) {
            save(parsedCap > 0, parsedCap * 100)
          }
        }}
      >
        <label htmlFor={capId} className="flex h-9 items-center text-xs font-medium">
          {t('components.billing.overageCapLabel', 'Monthly overage cap')}
        </label>
        <div className="space-y-1">
          <SettingsDisabledControlTooltip reason={blockedReason}>
            <div className="relative w-32">
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
              >
                $
              </span>
              <Input
                ref={capInputRef}
                id={capId}
                inputMode="numeric"
                adornment="leading"
                value={capDollars}
                readOnly={paymentFailed}
                aria-disabled={paymentFailed || undefined}
                aria-invalid={!capValid || undefined}
                aria-describedby={capValid ? hintId : `${capErrorId} ${hintId}`}
                onChange={(event) => {
                  setCapDollars(event.target.value)
                  setSavedFlash(false)
                }}
              />
            </div>
          </SettingsDisabledControlTooltip>
          {capValid ? null : (
            <p id={capErrorId} className="text-xs text-destructive">
              {capZero
                ? t(
                    'components.billing.capZero',
                    'Set a cap above $0, or turn overage off.'
                  )
                : capTooHigh && maxCapCents !== null
                  ? capTooHighCopy(maxCapCents, locale, t)
                  : t('auto.components.billing.capInvalid', 'Enter a whole dollar amount.')}
            </p>
          )}
        </div>
        {savedFlash ? (
          <span
            ref={savedRef}
            tabIndex={-1}
            role="status"
            className="flex h-9 items-center gap-1 text-xs text-muted-foreground outline-none"
          >
            <Check className="size-3.5" />
            {busy || changed
              ? t('auto.components.billing.capSaving', 'Saving…')
              : t('auto.components.billing.capSaved', 'Saved')}
          </span>
        ) : changed ? (
          <Button type="submit" variant="outline" aria-disabled={busy || undefined}>
            {t('auto.components.billing.saveCap', 'Save')}
          </Button>
        ) : null}
        <p id={hintId} className="basis-full text-xs text-muted-foreground">
          {hint}
        </p>
        {capValid && entitlement.reason === 'overage_cap_reached' ? (
          <p className="basis-full text-xs text-muted-foreground">
            {t(
              'auto.components.billing.capReachedHint2',
              'Raise the cap to start sandboxes again. Your sandboxes are asleep, and your files are safe.'
            )}
          </p>
        ) : null}
      </form>
      {spent}
      <SettingsDisabledControlTooltip reason={blockedReason}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          aria-disabled={busy || paymentFailed || undefined}
          onClick={() => {
            if (!busy && !paymentFailed) {
              save(false, 0)
            }
          }}
        >
          {t('components.billing.overage.turnOff', 'Turn off overage')}
        </Button>
      </SettingsDisabledControlTooltip>
      {alertsNote}
    </div>
  )
}
