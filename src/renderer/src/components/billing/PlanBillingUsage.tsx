import { useEffect, useId, useRef, useState } from 'react'
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
import { OverageSaveStatus, useOverageSaveState, type OverageAction } from './overage-save-state'
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
  const capInputRef = useRef<HTMLInputElement>(null)
  const turnOnRef = useRef<HTMLButtonElement>(null)
  // Set by Turn on / Turn off: once the card switches, focus lands on the new view's control (N-09).
  const focusOnSwitch = useRef(false)
  const { overage } = entitlement
  useEffect(() => {
    if (focusOnSwitch.current) {
      focusOnSwitch.current = false
      if (overage.optedIn) {
        capInputRef.current?.focus()
      } else {
        turnOnRef.current?.focus()
      }
    }
  }, [overage.optedIn])
  // One field: the cap while overage is on, $0 while it's off.
  const savedDollars = overage.optedIn ? String(Math.round(overage.spendCapCents / 100)) : '0'
  // Billing's default cap; unknown (no catalog) sends none and billing applies its own.
  const defaultCapCents = entitlement.offers?.team.defaultSpendCapCents ?? null
  const [capDollars, setCapDollars] = useState(savedDollars)
  // Re-seed from the server whenever the saved values change (render-time adjustment, no effect).
  const [seededFrom, setSeededFrom] = useState(savedDollars)
  if (seededFrom !== savedDollars) {
    setSeededFrom(savedDollars)
    setCapDollars(savedDollars)
  }
  const { status, action, begin, clear } = useOverageSaveState({
    overage,
    busy,
    failures,
    // Roll back to what billing has.
    onFailure: () => setCapDollars(savedDollars)
  })
  const saving = status === 'saving'
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
                'components.billing.overage.memberOn5',
                'Overage is on, up to your {{cap}} spend cap.',
                { cap: formatCents(overage.spendCapCents, locale) }
              )
            : t(
                'components.billing.overage.memberOff5',
                'Off until an owner or admin turns it on.'
              )}
        </p>
        {overage.optedIn ? spent : null}
      </div>
    )
  }

  const save = (action: OverageAction, cents: number | null): void => {
    const enabled = action !== 'off'
    begin({ action, optedIn: enabled, capCents: enabled ? cents : null })
    onSetOverage(
      !enabled
        ? { enabled: false }
        : cents === null
          ? { enabled: true }
          : { enabled: true, spendCapCents: cents }
    )
  }
  const blocked = busy || saving || paymentFailed
  const statusLine = <OverageSaveStatus status={status} action={action} />
  // Turn off's status sits by its link, so it doesn't read as the cap failing (design-squad).
  const offStatus = action === 'off'
  const blockedReason = paymentFailed
    ? t(
        'auto.components.billing.overagePaymentFailed',
        'Update the payment method before changing overage.'
      )
    : undefined
  const alertLevels = entitlement.offers?.team.warnAtPercent ?? null
  const alertsNote = (
    <p className="text-xs text-muted-foreground">
      {alertLevels && alertLevels.length > 0
        ? t(
            'auto.components.billing.usageAlertsNoteLevels',
            'Owners and admins are alerted in Orca at {{levels}} of your team’s sandbox hours.',
            { levels: formatPercentList(alertLevels, locale) }
          )
        : t(
            'auto.components.billing.usageAlertsNoteGeneric',
            'Owners and admins are alerted in Orca as your team’s sandbox hours run low.'
          )}
    </p>
  )
  const turnOn = (): void => {
    if (blocked) {
      return
    }
    if (defaultCapCents !== null) {
      setCapDollars(String(Math.round(defaultCapCents / 100)))
    }
    focusOnSwitch.current = true
    save('on', defaultCapCents)
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
            'components.billing.overage.offStatus2',
            'Overage is off. Running sandboxes go to sleep and new ones can’t start when your team runs out of sandbox hours.'
          )}
        </p>
        {/* Turn on is always here, whatever the last change did (OVERAGE-REENABLE). */}
        <div className="flex flex-wrap items-center gap-2">
          <SettingsDisabledControlTooltip reason={blockedReason}>
            <Button
              ref={turnOnRef}
              type="button"
              variant="outline"
              aria-disabled={blocked || undefined}
              onClick={paymentFailed ? undefined : turnOn}
            >
              {defaultCapCents === null
                ? t('auto.components.billing.overage.turnOnNoCap', 'Turn on overage')
                : t('auto.components.billing.overage.turnOn', 'Turn on with a {{cap}} cap', {
                    cap: formatCents(defaultCapCents, locale)
                  })}
            </Button>
          </SettingsDisabledControlTooltip>
          {statusLine}
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
          if (changed && !blocked) {
            save('cap', parsedCap * 100)
            // Save turns into the status in place; keep focus in the card on the field.
            capInputRef.current?.focus()
          }
        }}
      >
        <label htmlFor={capId} className="flex h-9 items-center text-xs font-medium">
          {t('auto.components.billing.capLabel2', 'Monthly spend cap')}
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
                  clear()
                }}
              />
            </div>
          </SettingsDisabledControlTooltip>
          {capValid ? null : (
            <p id={capErrorId} className="text-xs text-destructive">
              {capZero
                ? t('components.billing.capZero2', 'Set a spend cap above $0, or turn overage off.')
                : capTooHigh && maxCapCents !== null
                  ? capTooHighCopy(maxCapCents, locale, t)
                  : t('auto.components.billing.capInvalid', 'Enter a whole dollar amount.')}
            </p>
          )}
        </div>
        {saving || !changed ? (
          offStatus ? null : (
            statusLine
          )
        ) : (
          <Button type="submit" variant="outline" aria-disabled={blocked || undefined}>
            {t('auto.components.billing.saveCap', 'Save')}
          </Button>
        )}
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
      <div className="flex flex-wrap items-center gap-3">
        <SettingsDisabledControlTooltip reason={blockedReason}>
          <Button
            type="button"
            variant="link-muted"
            size="inline"
            aria-disabled={blocked || undefined}
            onClick={() => {
              if (!blocked) {
                focusOnSwitch.current = true
                save('off', null)
              }
            }}
          >
            {/* Reads as a link at rest, not only on hover (design-squad, as RR-c1). */}
            <span className="underline underline-offset-4">
              {t('components.billing.overage.turnOff', 'Turn off overage')}
            </span>
          </Button>
        </SettingsDisabledControlTooltip>
        {offStatus ? statusLine : null}
      </div>
      {alertsNote}
    </div>
  )
}

/** "75%, 90% and 100%" in the UI locale (billing's alert levels). */
function formatPercentList(levels: readonly number[], locale: string): string {
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })
  // House style has no serial comma in English (en-US's ListFormat adds one).
  const listLocale = locale.toLowerCase().startsWith('en') ? 'en-GB' : locale
  return new Intl.ListFormat(listLocale, { type: 'conjunction' }).format(
    levels.map((level) => percent.format(level / 100))
  )
}
