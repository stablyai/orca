import React from 'react'
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { openPlansDialog } from '@/components/billing/plans/plans-dialog-store'
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'

/** The four ways billing can refuse a create. */
export type BillingBlockKind = 'plan' | 'hoursUsed' | 'spendCap' | 'payment'

export type BillingBlockerPhase =
  | { kind: 'idle' }
  /** A fix elsewhere: the plans dialog (then the console), or the console's billing page for
   *  overage, the spend cap and payment. Re-check on return, or with Check again. */
  | { kind: 'browser'; checking: boolean; stillBlocked: boolean; via: 'plans' | 'console' }

/** Why there is no plan, in billing's words: only a plan that existed has "ended". */
function planBlockBody(
  reason: string | null | undefined,
  t: Translate,
  canManageBilling: boolean | undefined
): string {
  switch (reason) {
    case 'subscription_inactive':
      return t('worktreeCreation.billingBlock.plan.body2', 'Your team’s plan has ended.')
    case 'trial_used_up':
      // Glossary (Trial used up): the person who can choose a plan reads "Your trial"; members
      // read their team's. An unknown role gets the team form.
      return canManageBilling === true
        ? t('worktreeCreation.billingBlock.plan.bodyTrialUsedUpAdmin', 'Your trial is used up.')
        : t('worktreeCreation.billingBlock.plan.bodyTrialUsedUp', 'Your team’s trial is used up.')
    case 'trial_unavailable':
      // Glossary: not eligible for a trial (one was already used); the title carries the action.
      return t(
        'worktreeCreation.billingBlock.plan.bodyTrialUnavailable',
        'This account or team already used its trial.'
      )
    case 'no_subscription':
      return t(
        'worktreeCreation.billingBlock.plan.bodyNoPlan',
        'Your team doesn’t have a plan yet.'
      )
    case null:
    case undefined:
    default:
      // Missing (older service) or a reason this build doesn't know.
      return t(
        'worktreeCreation.billingBlock.plan.bodyNeedsPlan',
        'Your team needs a plan to use Orca Cloud.'
      )
  }
}

/** The blocker's words per refusal; also the waking card's, so a refused wake says the same. */
export function blockerCopy(
  kind: BillingBlockKind,
  t: Translate,
  /** Billing's refusal reason: says whether a plan ended, a trial ran out, or there never was one. */
  reason?: string | null,
  /** Owners/admins read "Your trial…"; members their team's (glossary). */
  canManageBilling?: boolean
): { title: string; body: string; ask: string } {
  switch (kind) {
    case 'plan':
      return {
        title: t('worktreeCreation.billingBlock.plan.title', 'Choose a plan'),
        body: planBlockBody(reason, t, canManageBilling),
        ask: t('worktreeCreation.billingBlock.plan.ask', 'Ask an owner or admin to choose a plan.')
      }
    case 'hoursUsed':
      return {
        title: t('worktreeCreation.billingBlock.hours.title', 'Out of sandbox hours'),
        body: t(
          'worktreeCreation.billingBlock.hours.body',
          'Your team has used all of this month’s sandbox hours.'
        ),
        ask: t('worktreeCreation.billingBlock.hours.ask', 'Ask an owner or admin to add hours.')
      }
    case 'spendCap':
      return {
        title: t('worktreeCreation.billingBlock.cap.title', 'Spend cap reached'),
        body: t(
          'worktreeCreation.billingBlock.cap.body',
          'Overage is on, and this month’s spend cap is used.'
        ),
        ask: t(
          'worktreeCreation.billingBlock.cap.ask',
          'Ask an owner or admin to raise the spend cap.'
        )
      }
    case 'payment':
      return {
        title: t('worktreeCreation.billingBlock.payment.title', 'Payment failed'),
        body: t('worktreeCreation.billingBlock.payment.body', 'New sandboxes can’t start.'),
        ask: t(
          'worktreeCreation.billingBlock.payment.ask',
          'Ask an owner or admin to update the payment method.'
        )
      }
  }
}

export type VmBuildBillingBlockerViewProps = {
  kind: BillingBlockKind
  /** Billing's refusal reason (plan blocks word "ended" vs "no plan yet" from it). */
  reason?: string | null
  canManageBilling: boolean
  phase: BillingBlockerPhase
  onComparePlans: () => void
  /** Overage, the spend cap and payment are changed on the web console's billing page. */
  onOpenBilling: () => void
  onCheckAgain: () => void
  onBackToDraft: () => void
}

/** The button that opens the console's billing page, worded for the fix it leads to. */
function openBillingLabel(kind: BillingBlockKind, t: Translate): string {
  switch (kind) {
    case 'spendCap':
      return t('worktreeCreation.billingBlock.raiseInBrowser', 'Raise in browser')
    case 'payment':
      return t('worktreeCreation.billingBlock.updateInBrowser', 'Update in browser')
    case 'hoursUsed':
    case 'plan':
      return t('worktreeCreation.billingBlock.turnOnInBrowser', 'Turn on in browser')
  }
}

/**
 * The creating sheet's billing blocker: replaces the steps when billing refuses a create. Nothing
 * was created and no hours were used; the draft is kept, and the create continues once billing
 * says a sandbox can start.
 */
export function VmBuildBillingBlockerView({
  kind,
  reason,
  canManageBilling,
  phase,
  onComparePlans,
  onOpenBilling,
  onCheckAgain,
  onBackToDraft
}: VmBuildBillingBlockerViewProps): React.JSX.Element {
  const t = useTranslate()
  const copy = blockerCopy(kind, t, reason, canManageBilling)
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  React.useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [kind])
  const inBrowser = phase.kind === 'browser'

  return (
    <div className="flex flex-col gap-3">
      <div
        role="alert"
        className="flex gap-3 rounded-lg border border-border bg-card px-4 py-4 text-sm"
      >
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-status-warning-text" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <h3 ref={headingRef} tabIndex={-1} className="font-semibold outline-none">
              {copy.title}
            </h3>
            <p className="text-muted-foreground">{copy.body}</p>
          </div>
          {canManageBilling ? (
            inBrowser ? (
              <div className="space-y-2">
                <p className="text-muted-foreground">
                  {phase.via === 'plans'
                    ? phase.stillBlocked
                      ? t(
                          'worktreeCreation.billingBlock.plansStill',
                          'No plan yet. Choose one, then check again.'
                        )
                      : t(
                          'worktreeCreation.billingBlock.plans',
                          'Choose a plan, then check again. Orca checks again when you come back.'
                        )
                    : phase.stillBlocked
                      ? t(
                          'worktreeCreation.billingBlock.browserStill',
                          'Not updated yet. Finish in your browser, then check again.'
                        )
                      : t('worktreeCreation.billingBlock.browser', 'Finish in your browser.')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {phase.via === 'plans' ? (
                    <Button type="button" size="sm" onClick={onComparePlans}>
                      {t('worktreeCreation.billingBlock.seePlans', 'See plans')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-busy={phase.checking || undefined}
                    aria-disabled={phase.checking || undefined}
                    onClick={phase.checking ? undefined : onCheckAgain}
                  >
                    {phase.checking ? <Loader2 className="animate-spin" /> : null}
                    {t('worktreeCreation.billingBlock.checkAgain', 'Check again')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {kind === 'plan' ? null : (
                  <Button type="button" size="sm" onClick={onOpenBilling}>
                    {openBillingLabel(kind, t)}
                    <ExternalLink />
                  </Button>
                )}
                {kind === 'plan' || kind === 'hoursUsed' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={kind === 'hoursUsed' ? 'outline' : 'default'}
                    onClick={onComparePlans}
                  >
                    {t('auto.components.billing.comparePlans', 'Compare plans')}
                  </Button>
                ) : null}
              </div>
            )
          ) : (
            <p className="text-muted-foreground">{copy.ask}</p>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={onBackToDraft}
      >
        {t('worktreeCreation.billingBlock.backToDraft', 'Back to draft')}
      </Button>
    </div>
  )
}

/**
 * The live blocker: every fix is in the browser (a plan through the plans dialog, overage, the
 * spend cap and payment on the console's billing page). It re-checks once when Orca regains focus,
 * or on Check again, and the create continues on its own once billing allows it.
 */
export function VmBuildBillingBlocker({
  kind,
  canManageBilling,
  entitlement,
  onContinue,
  onBackToDraft
}: {
  kind: BillingBlockKind
  canManageBilling: boolean
  entitlement: OrcaBillingEntitlement | null
  /** Starts the create again from "Checking your plan…". */
  onContinue: () => void
  onBackToDraft: () => void
}): React.JSX.Element {
  const [phase, setPhase] = React.useState<BillingBlockerPhase>({
    kind: 'idle'
  })

  const checkBilling = React.useCallback(async (): Promise<void> => {
    const via = (current: BillingBlockerPhase): 'plans' | 'console' =>
      current.kind === 'browser' ? current.via : 'console'
    setPhase((current) => ({
      kind: 'browser',
      checking: true,
      stillBlocked: false,
      via: via(current)
    }))
    const status = await window.api.orcaProfiles.billingStatus().catch(() => null)
    // The service's own verdict: overage on, a higher cap or a fixed payment makes new sandboxes
    // startable again.
    if (status?.status === 'ok' && status.entitlement.canStartSandbox) {
      onContinue()
      return
    }
    setPhase((current) => ({
      kind: 'browser',
      checking: false,
      stillBlocked: true,
      via: via(current)
    }))
  }, [onContinue])

  // Back from the browser: check once; if billing is fine the create continues on its own.
  const waitingOnBrowser = phase.kind === 'browser'
  React.useEffect(() => {
    if (!waitingOnBrowser) {
      return
    }
    const onFocus = (): void => {
      window.removeEventListener('focus', onFocus)
      void checkBilling()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [waitingOnBrowser, checkBilling])

  return (
    <VmBuildBillingBlockerView
      kind={kind}
      reason={entitlement?.reason ?? null}
      canManageBilling={canManageBilling}
      phase={phase}
      onComparePlans={() => {
        setPhase({ kind: 'browser', checking: false, stillBlocked: false, via: 'plans' })
        openPlansDialog()
      }}
      onOpenBilling={() => {
        setPhase({ kind: 'browser', checking: false, stillBlocked: false, via: 'console' })
        void openCloudConsole('billing')
      }}
      onCheckAgain={() => void checkBilling()}
      onBackToDraft={onBackToDraft}
    />
  )
}
