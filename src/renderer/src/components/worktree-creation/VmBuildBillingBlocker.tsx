import React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  OrcaBillingEntitlement,
  OrcaBillingOverageResult
} from '../../../../shared/orca-billing'
import { overageFailureCopy } from '../billing/plan-billing-copy'
import { openPlansPage } from '../billing/plans/plans-page-store'
import { requestOrcaCloudAfterCheckout } from '@/lib/orca-cloud-after-checkout'
import { formatCents } from '../billing/plans/plans-pricing'

/** The four ways billing can refuse a create (JA-21 progressive billing). */
export type BillingBlockKind = 'plan' | 'hoursUsed' | 'spendCap' | 'payment'

export type BillingBlockerPhase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  /** A fix in the browser (portal): re-check on return, or with Check again. */
  | { kind: 'browser'; checking: boolean; stillBlocked: boolean }

function blockerCopy(
  kind: BillingBlockKind,
  t: Translate
): { title: string; body: string; ask: string } {
  switch (kind) {
    case 'plan':
      return {
        title: t('worktreeCreation.billingBlock.plan.title', 'Choose a plan'),
        body: t(
          'worktreeCreation.billingBlock.plan.body',
          'Your team needs a plan to start cloud workspaces.'
        ),
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
  canManageBilling: boolean
  phase: BillingBlockerPhase
  /** Spend cap reached: the field's starting value, in whole dollars. */
  suggestedCapDollars: number
  /** Billing's default cap for "Turn on with a $X cap"; null: plain "Turn on overage" (ENTITLEMENTS-C). */
  defaultCapCents: number | null
  onTurnOnOverage: () => void
  onRaiseCap: (dollars: number) => void
  onComparePlans: () => void
  onUpdatePayment: () => void
  onCheckAgain: () => void
  onBackToDraft: () => void
}

/**
 * The creating sheet's billing blocker: replaces the steps when billing refuses a create. Nothing
 * was created and no hours were used; the draft is kept, and an in-app fix continues the create.
 */
export function VmBuildBillingBlockerView({
  kind,
  canManageBilling,
  phase,
  suggestedCapDollars,
  defaultCapCents,
  onTurnOnOverage,
  onRaiseCap,
  onComparePlans,
  onUpdatePayment,
  onCheckAgain,
  onBackToDraft
}: VmBuildBillingBlockerViewProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const copy = blockerCopy(kind, t)
  const capId = React.useId()
  const [cap, setCap] = React.useState(String(suggestedCapDollars))
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  React.useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [kind])
  const saving = phase.kind === 'saving'
  const capDollars = Number(cap)
  const capValid = /^\d+$/.test(cap.trim()) && capDollars > 0
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
                  {phase.stillBlocked
                    ? t(
                        'worktreeCreation.billingBlock.browserStill',
                        'Not updated yet. Finish in your browser, then check again.'
                      )
                    : t('worktreeCreation.billingBlock.browser', 'Finish in your browser.')}
                </p>
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
            ) : kind === 'spendCap' ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!saving && capValid) {
                    onRaiseCap(capDollars)
                  }
                }}
              >
                <div className="space-y-1">
                  <label htmlFor={capId} className="block text-xs font-medium">
                    {t('auto.components.billing.capLabel2', 'Monthly spend cap')}
                  </label>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">$</span>
                    <Input
                      id={capId}
                      inputMode="numeric"
                      className="w-24"
                      value={cap}
                      aria-invalid={!capValid || undefined}
                      onChange={(event) => setCap(event.target.value)}
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  size="sm"
                  aria-busy={saving || undefined}
                  aria-disabled={saving || !capValid || undefined}
                >
                  {saving ? <Loader2 className="animate-spin" /> : null}
                  {t(
                    'worktreeCreation.billingBlock.raiseCapAndContinue',
                    'Raise spend cap and continue'
                  )}
                </Button>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                {kind === 'hoursUsed' ? (
                  <Button
                    type="button"
                    size="sm"
                    aria-busy={saving || undefined}
                    aria-disabled={saving || undefined}
                    onClick={saving ? undefined : onTurnOnOverage}
                  >
                    {saving ? <Loader2 className="animate-spin" /> : null}
                    {defaultCapCents === null
                      ? t('auto.components.billing.overage.turnOnNoCap', 'Turn on overage')
                      : t('auto.components.billing.overage.turnOn', 'Turn on with a {{cap}} cap', {
                          cap: formatCents(defaultCapCents, locale)
                        })}
                  </Button>
                ) : null}
                {kind === 'payment' ? (
                  <Button type="button" size="sm" onClick={onUpdatePayment}>
                    {t(
                      'auto.components.worktree.creation.VmBuildFailureCard.updatePayment',
                      'Update payment method'
                    )}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant={kind === 'hoursUsed' ? 'outline' : 'default'}
                    onClick={onComparePlans}
                  >
                    {t('auto.components.billing.comparePlans', 'Compare plans')}
                  </Button>
                )}
              </div>
            )
          ) : (
            <p className="text-muted-foreground">{copy.ask}</p>
          )}
          {phase.kind === 'error' ? (
            <p role="status" className="text-destructive-text">
              {phase.message}
            </p>
          ) : null}
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
 * The live blocker: in-app fixes (overage, a higher cap) save and continue the create at once; a
 * browser fix (payment) re-checks once when Orca regains focus, or on Check again.
 */
export function VmBuildBillingBlocker({
  kind,
  creationId,
  canManageBilling,
  entitlement,
  onContinue,
  onBackToDraft
}: {
  kind: BillingBlockKind
  /** The blocked create: a paid checkout from Compare plans continues it. */
  creationId: string
  canManageBilling: boolean
  entitlement: OrcaBillingEntitlement | null
  /** Starts the create again from "Checking your plan…". */
  onContinue: () => void
  onBackToDraft: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [phase, setPhase] = React.useState<BillingBlockerPhase>({
    kind: 'idle'
  })
  // Plan numbers come from billing, never guessed (ENTITLEMENTS-C): a reached cap suggests one more
  // default cap on top; without billing's default, double the current cap.
  const currentCap = entitlement?.overage.spendCapCents ?? 0
  const defaultCapCents = entitlement?.offers?.team.defaultSpendCapCents ?? null
  const suggestedCapDollars = Math.round((currentCap + (defaultCapCents ?? currentCap)) / 100)
  const maxCap = entitlement?.offers?.team.maxSpendCapCents ?? null

  const saveOverage = async (spendCapCents: number | null): Promise<void> => {
    setPhase({ kind: 'saving' })
    const outcome = await window.api.orcaProfiles
      .billingSetOverage(
        spendCapCents === null ? { enabled: true } : { enabled: true, spendCapCents }
      )
      .catch((error: unknown): OrcaBillingOverageResult => ({
        status: 'failed',
        error: String(error)
      }))
    if (outcome.status === 'ok') {
      onContinue()
      return
    }
    setPhase({
      kind: 'error',
      message:
        overageFailureCopy(outcome, t, maxCap, locale) ??
        t(
          'worktreeCreation.billingBlock.saveFailed',
          'Couldn’t save that. Try again, or change it in Plan & billing.'
        )
    })
  }

  const checkBilling = React.useCallback(async (): Promise<void> => {
    setPhase({ kind: 'browser', checking: true, stillBlocked: false })
    const status = await window.api.orcaProfiles.billingStatus().catch(() => null)
    // The service's own verdict: a fixed payment makes new sandboxes startable again.
    if (status?.status === 'ok' && status.entitlement.canStartSandbox) {
      onContinue()
      return
    }
    setPhase({ kind: 'browser', checking: false, stillBlocked: true })
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
      canManageBilling={canManageBilling}
      phase={phase}
      suggestedCapDollars={suggestedCapDollars}
      defaultCapCents={defaultCapCents}
      onTurnOnOverage={() => void saveOverage(defaultCapCents)}
      onRaiseCap={(dollars) => void saveOverage(dollars * 100)}
      onComparePlans={() => {
        // Once paid, the plans page closes and continues this create.
        requestOrcaCloudAfterCheckout({ kind: 'retry', creationId })
        openPlansPage('sandbox')
      }}
      onUpdatePayment={() => {
        setPhase({ kind: 'browser', checking: false, stillBlocked: false })
        void window.api.orcaProfiles.billingOpenPortal().catch(() => {})
      }}
      onCheckAgain={() => void checkBilling()}
      onBackToDraft={onBackToDraft}
    />
  )
}
