// The plans dialog: the team's plan and status, then billing's plan cards, with "Continue in
// browser" into the web console, where the person signs in, picks seats and pays. A read-only sales
// and status surface: no checkout, usage history or admin settings in the desktop.
import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  isOrcaCloudTrial,
  type OrcaBillingInterval,
  type OrcaBillingStatusResult
} from '../../../../../shared/orca-billing'
import type { OrcaPlanCatalogResult } from '../../../../../shared/orca-billing-plans'
import { PaymentIssueNotice } from '../PaymentIssueNotice'
import { isActivePlan } from '../plan-billing-format'
import {
  EnterprisePlanCard,
  PlansIntervalToggle,
  TeamPlanCard,
  type TeamPlanCardMode
} from './PlanCards'
import { CurrentPlanStrip, TrialOfferStrip, TrialStrip } from './PlansCurrentPlan'
import { resolvePlansModel } from './plans-model'
import { annualSavingsPercent, shownInterval } from './plans-pricing'

export type PlansDialogViewProps = {
  /** null while billing's first answer is on its way. */
  billing: OrcaBillingStatusResult | null
  /** null while the plan catalog loads. */
  catalog: OrcaPlanCatalogResult | null
  /** Owner or admin of the active team (the console's billing rule). */
  canManage: boolean
  /** The console is being opened (a ticket is minted first). */
  opening: boolean
  onContinue: () => void
  onContactSales: (url: string) => void
  onRetry: () => void
}

function SkeletonCard(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-5 rounded-xl border border-border bg-card p-5 shadow-xs">
      <Skeleton className="h-4 w-24" />
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="flex-1 space-y-3">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className={index % 2 ? 'h-3 w-4/5' : 'h-3 w-11/12'} />
        ))}
      </div>
      <div className="min-h-[6rem] space-y-2 border-t border-border/60 pt-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="mx-auto h-3 w-3/5" />
      </div>
    </div>
  )
}

function PlansSkeleton(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="space-y-6"
      role="status"
      aria-label={t('auto.components.billing.plans.loading', 'Loading plans…')}
    >
      <Skeleton className="h-[5.5rem] w-full" />
      <div className="grid items-stretch gap-4 md:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    </div>
  )
}

function useHeading(props: PlansDialogViewProps): { title: string; description: string | null } {
  const t = useTranslate()
  const entitlement = props.billing?.status === 'ok' ? props.billing.entitlement : null
  if (!entitlement || isActivePlan(entitlement)) {
    // Never an upsell before billing answers: a paying team must not see one flash by.
    return {
      title: entitlement
        ? t('auto.components.billing.plans.titleSubscribed', 'Your Orca Cloud plan')
        : t('auto.components.billing.plans.titleNeutral', 'Orca Cloud plans'),
      description: null
    }
  }
  return {
    title: t('auto.components.billing.plans.title', 'Cloud sandboxes for your whole team'),
    description: t(
      'auto.components.billing.plans.subtitle2',
      'Run Orca agents in hosted sandboxes that keep going when you step away.'
    )
  }
}

function PlansBody(props: PlansDialogViewProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [picked, setPicked] = useState<OrcaBillingInterval>('month')
  const plans = resolvePlansModel(props.catalog, props.billing)
  const billing = props.billing

  if (billing === null || plans.state === 'loading') {
    return <PlansSkeleton />
  }
  if (billing.status === 'signed-out' || billing.status === 'unconfigured') {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {billing.status === 'signed-out'
          ? t('auto.components.billing.plans.signedOut', 'Sign in to Orca to see your team’s plan.')
          : t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')}
      </p>
    )
  }

  const entitlement = billing.status === 'ok' ? billing.entitlement : null
  const subscribed = isActivePlan(entitlement)
  const trial = entitlement && isOrcaCloudTrial(entitlement) ? entitlement : null

  const status = entitlement ? (
    subscribed ? (
      <>
        <PaymentIssueNotice
          entitlement={{ ...entitlement, canManageBilling: props.canManage }}
          busy={props.opening}
          onUpdatePayment={props.onContinue}
        />
        <CurrentPlanStrip entitlement={entitlement} />
      </>
    ) : trial ? (
      <TrialStrip entitlement={trial} canManage={props.canManage} />
    ) : plans.state === 'ready' && plans.model.trial && entitlement.offers?.trial ? (
      <TrialOfferStrip trial={plans.model.trial} />
    ) : null
  ) : null

  if (plans.state === 'unavailable') {
    // Offline with nothing saved: say so, and still offer the console (it lists the plans).
    return (
      <div className="space-y-6">
        {status}
        <InlineError
          tone="neutral"
          className="mx-auto max-w-md"
          title={t('auto.components.billing.plans.loadFailedTitle', 'Plans didn’t load')}
          detail={t(
            'auto.components.billing.plans.loadFailedConsole',
            'Check your connection and try again, or see plans in your browser.'
          )}
          retryLabel={t('auto.components.billing.plans.retry', 'Try again')}
          onRetry={props.onRetry}
        />
        {props.canManage ? (
          <div className="flex justify-center">
            <Button
              type="button"
              aria-disabled={props.opening || undefined}
              onClick={props.opening ? undefined : props.onContinue}
            >
              {t('auto.components.billing.plans.continueInBrowser', 'Continue in browser')}
              <ExternalLink />
            </Button>
          </div>
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            {t('auto.components.billing.plans.askAdmin', 'Ask a team admin to upgrade.')}
          </p>
        )}
      </div>
    )
  }

  const { team, enterprise, source } = plans.model
  const mode: TeamPlanCardMode = !props.canManage ? 'member' : subscribed ? 'current' : 'choose'
  const interval =
    subscribed && entitlement?.interval
      ? entitlement.interval
      : shownInterval(picked, team.intervals)
  const fetchedAt = props.catalog?.status === 'ok' ? props.catalog.fetchedAt : null

  return (
    <div className="space-y-6">
      {status}
      {!subscribed && team.intervals.length > 1 ? (
        <PlansIntervalToggle
          value={interval}
          savingsPercent={annualSavingsPercent(team)}
          onChange={setPicked}
        />
      ) : null}
      <div className={enterprise ? 'grid items-stretch gap-4 md:grid-cols-2' : 'mx-auto max-w-md'}>
        <TeamPlanCard
          team={team}
          interval={interval}
          seats={subscribed && entitlement ? entitlement.seats : null}
          mode={mode}
          opening={props.opening}
          onContinue={mode === 'member' ? null : props.onContinue}
        />
        {enterprise ? (
          <EnterprisePlanCard enterprise={enterprise} onContactSales={props.onContactSales} />
        ) : null}
      </div>
      {source === 'cache' && fetchedAt ? (
        <p className="text-center text-xs text-muted-foreground">
          {t(
            'auto.components.billing.plans.savedCopy',
            'Offline: plans as of {{date}}. Your browser shows current prices.',
            { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(fetchedAt) }
          )}
        </p>
      ) : null}
    </div>
  )
}

export function PlansDialogView(props: PlansDialogViewProps): React.JSX.Element {
  const heading = useHeading(props)
  const ready = props.billing !== null && props.catalog !== null
  // Land on the heading once plans load, never on a button (Enter would open the browser).
  useEffect(() => {
    const active = document.activeElement
    if (
      ready &&
      (!active || active === document.body || active.getAttribute('role') === 'dialog')
    ) {
      document.querySelector<HTMLElement>('[role="dialog"] [data-plans-heading]')?.focus()
    }
  }, [ready])
  const t = useTranslate()
  return (
    <DialogContent
      scrollable
      className="top-[6vh] max-h-[88vh] translate-y-0 sm:max-w-4xl [@media(max-height:800px)]:top-4 [@media(max-height:800px)]:max-h-[calc(100vh-2rem)]"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        if (event.currentTarget instanceof HTMLElement) {
          const heading = event.currentTarget.querySelector<HTMLElement>('[data-plans-heading]')
          ;(heading ?? event.currentTarget).focus()
        }
      }}
    >
      <DialogHeader className="items-center text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('auto.components.billing.plans.eyebrow', 'Orca Cloud')}
        </p>
        <DialogTitle size="display" tabIndex={-1} data-plans-heading="">
          {heading.title}
        </DialogTitle>
        <DialogDescription
          className={heading.description ? 'mx-auto max-w-xl text-center' : 'sr-only'}
        >
          {heading.description ??
            t(
              'auto.components.billing.plans.subtitleSubscribed2',
              'Your plan, its sandbox hours, and what Enterprise adds.'
            )}
        </DialogDescription>
      </DialogHeader>
      <PlansBody {...props} />
    </DialogContent>
  )
}
