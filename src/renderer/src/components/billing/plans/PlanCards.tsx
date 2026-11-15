// The plans dialog's cards: Team (per-seat prices, monthly or annual) and Enterprise (contact
// sales). Names, prices, bullets, taglines and button labels are billing's catalog; the cards only
// lay them out. Read-only: choosing seats and paying happen in the web console.
import type { ReactNode } from 'react'
import { Building2, Check, ExternalLink, Lock, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsSegmentedControl } from '@/components/settings/form-controls/SettingsSegmentedControl'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingInterval } from '../../../../../shared/orca-billing'
import { formatCents } from '../../../../../shared/orca-billing-usage-alerts'
import type { EnterprisePlanModel, TeamPlanModel } from './plans-model'
import { perSeatMonthlyCents } from './plans-pricing'

function PlanCardShell({
  id,
  title,
  badge,
  tagline,
  price,
  priceNote,
  featuresLead,
  features,
  footer
}: {
  id: string
  title: ReactNode
  badge?: ReactNode
  tagline: string | null
  price: ReactNode
  priceNote: ReactNode
  featuresLead?: string | null
  features: string[]
  footer: ReactNode
}): React.JSX.Element {
  return (
    <section
      aria-labelledby={id}
      className="flex h-full flex-col gap-5 rounded-xl border border-border bg-card p-5 shadow-xs"
    >
      <div className="space-y-1">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <h3 id={id} className="flex items-center gap-2 text-base font-semibold">
            {title}
          </h3>
          {badge}
        </div>
        {tagline ? <p className="text-xs text-muted-foreground text-pretty">{tagline}</p> : null}
      </div>
      <div className="space-y-1">
        {price}
        <p className="text-xs text-muted-foreground">{priceNote}</p>
      </div>
      <div className="flex-1 space-y-2.5">
        {featuresLead && features.length > 0 ? (
          <p className="text-xs font-medium text-muted-foreground">{featuresLead}</p>
        ) : null}
        <ul className="space-y-2.5">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-sm text-pretty">
              <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
      {/* Same footer height on both cards keeps their dividers and buttons level. */}
      <div className="flex min-h-[6rem] flex-col justify-start gap-2 border-t border-border/60 pt-4">
        {footer}
      </div>
    </section>
  )
}

export function PlansIntervalToggle({
  value,
  savingsPercent,
  onChange
}: {
  value: OrcaBillingInterval
  savingsPercent: number | null
  onChange: (interval: OrcaBillingInterval) => void
}): React.JSX.Element {
  const t = useTranslate()
  const annual = t('auto.components.billing.plans.annual', 'Annual')
  const save =
    savingsPercent === null
      ? null
      : t('auto.components.billing.plans.savePercent', 'Save {{value0}}%', {
          value0: String(savingsPercent)
        })
  return (
    <div className="mx-auto flex w-72 justify-center">
      <SettingsSegmentedControl<OrcaBillingInterval>
        value={value}
        onChange={onChange}
        size="sm"
        equalWidth
        ariaLabel={t('auto.components.billing.plans.billingPeriod', 'Billing period')}
        options={[
          { value: 'month', label: t('auto.components.billing.plans.monthly', 'Monthly') },
          {
            value: 'year',
            label: save ? (
              <span className="flex items-center gap-1.5">
                {annual}
                <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] font-semibold tabular-nums">
                  {save}
                </span>
              </span>
            ) : (
              annual
            ),
            ariaLabel: save ? `${annual}, ${save}` : undefined
          }
        ]}
      />
    </div>
  )
}

export type TeamPlanCardMode =
  /** Owner or admin, no plan yet: continue in the browser to choose seats and pay. */
  | 'choose'
  /** Already on this plan; owners and admins manage it in the browser. */
  | 'current'
  /** A member: the plan is shown, an owner or admin chooses it. */
  | 'member'

export function TeamPlanCard({
  team,
  interval,
  seats,
  mode,
  opening,
  onContinue
}: {
  team: TeamPlanModel
  interval: OrcaBillingInterval
  /** Seats on the current plan, when there is one. */
  seats: number | null
  mode: TeamPlanCardMode
  onContinue: (() => void) | null
  opening: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const fmt = (cents: number): string => formatCents(cents, locale, team.currency)
  const monthly = perSeatMonthlyCents(team, interval)
  const fullMonthly = team.monthlyPriceCentsPerSeat
  const discounted =
    interval === 'year' && monthly !== null && fullMonthly !== null && monthly < fullMonthly
  const legacyLabel = team.legacyPriceLabels?.[interval] || null

  const price = (
    // Keyed so the figure fades in again when the period changes.
    <p
      key={interval}
      className="flex items-baseline gap-1.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
    >
      {discounted && fullMonthly !== null ? (
        <del className="text-lg text-muted-foreground tabular-nums">
          <span className="sr-only">{t('auto.components.billing.plans.was', 'Was')} </span>
          {fmt(fullMonthly)}
        </del>
      ) : null}
      {monthly === null ? (
        <span className="text-lg font-semibold tracking-tight">
          {legacyLabel ?? t('auto.components.billing.plans.priceInBrowser', 'See price in browser')}
        </span>
      ) : (
        <>
          <span className="text-3xl font-semibold tracking-tight tabular-nums">{fmt(monthly)}</span>
          <span className="text-sm text-muted-foreground">
            {t('auto.components.billing.plans.perSeatPerMonth', 'per seat per month')}
          </span>
        </>
      )}
    </p>
  )

  const billed =
    interval === 'year'
      ? team.annualPriceCentsPerSeat === null
        ? t('auto.components.billing.plans.billedYearly', 'Billed yearly')
        : t(
            'auto.components.billing.plans.billedYearlyAmount2',
            '{{value0}} per seat, billed yearly',
            {
              value0: fmt(team.annualPriceCentsPerSeat)
            }
          )
      : t('auto.components.billing.plans.billedMonthly', 'Billed monthly')
  const priceNote =
    seats === null
      ? billed
      : t('auto.components.billing.plans.seatsBilled', '{{count}} seats · {{billed}}', {
          count: seats,
          billed,
          defaultValue_one: '{{count}} seat · {{billed}}'
        })

  const continueButton = onContinue ? (
    <Button
      type="button"
      variant={mode === 'current' ? 'outline' : 'default'}
      className="w-full"
      aria-disabled={opening || undefined}
      onClick={opening ? undefined : onContinue}
    >
      {mode === 'current'
        ? t('settings.cloudConsole.manageInBrowser', 'Manage in browser')
        : (team.marketing?.ctaLabel ??
          t('auto.components.billing.plans.continueInBrowser', 'Continue in browser'))}
      <ExternalLink />
    </Button>
  ) : null

  let footer: ReactNode
  if (mode === 'member') {
    footer = (
      <div className="flex items-start gap-2 text-sm">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-pretty">
          {seats === null
            ? t('auto.components.billing.plans.askAdmin', 'Ask a team admin to upgrade.')
            : t(
                'auto.components.billing.plans.adminsManage',
                'Your team’s owners and admins manage this plan.'
              )}
        </p>
      </div>
    )
  } else if (mode === 'current') {
    footer = (
      <>
        {continueButton}
        <p className="text-center text-xs text-muted-foreground text-pretty">
          {t(
            'auto.components.billing.plans.manageHint2',
            'Change seats or billing period, see invoices, or update payment.'
          )}
        </p>
      </>
    )
  } else {
    footer = (
      <>
        {continueButton}
        <p className="text-center text-xs text-muted-foreground text-pretty">
          {t(
            'auto.components.billing.plans.continueHint2',
            'Sign in on the web to choose seats and pay.'
          )}
        </p>
      </>
    )
  }

  return (
    <PlanCardShell
      id="plans-team-title"
      title={
        <>
          <Users className="size-4 text-muted-foreground" />
          {team.label}
        </>
      }
      badge={
        mode === 'current' || (mode === 'member' && seats !== null) ? (
          <Badge variant="secondary">
            {t('auto.components.billing.plans.currentPlan', 'Current plan')}
          </Badge>
        ) : null
      }
      tagline={team.marketing?.tagline ?? null}
      price={price}
      priceNote={priceNote}
      featuresLead={team.marketing?.featuresLead}
      features={team.features}
      footer={footer}
    />
  )
}

export function EnterprisePlanCard({
  enterprise,
  onContactSales
}: {
  enterprise: EnterprisePlanModel
  onContactSales: (url: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const contactUrl = enterprise.contactUrl
  return (
    <PlanCardShell
      id="plans-enterprise-title"
      title={
        <>
          <Building2 className="size-4 text-muted-foreground" />
          {enterprise.label}
        </>
      }
      tagline={enterprise.marketing?.tagline ?? null}
      price={
        enterprise.priceLabel ? (
          <p className="text-3xl font-semibold tracking-tight">{enterprise.priceLabel}</p>
        ) : null
      }
      priceNote={t('auto.components.billing.plans.entPriced2', 'Priced for your team')}
      featuresLead={enterprise.marketing?.featuresLead}
      features={enterprise.features}
      footer={
        contactUrl ? (
          <>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => onContactSales(contactUrl)}
            >
              {enterprise.marketing?.ctaLabel ??
                t('auto.components.billing.plans.contactSales', 'Contact sales')}
              <ExternalLink />
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t(
                'auto.components.billing.plans.entHint',
                'Tell us about your team and where you run.'
              )}
            </p>
          </>
        ) : null
      }
    />
  )
}
