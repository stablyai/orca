// The one fix on a refused wake's card, for an owner or admin, with the create sheet's labels and
// behaviour: Turn on overage applies here and wakes again; the others open where the fix is made.
import React from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import {
  getLastBillingStatus,
  refreshBillingSummary
} from '@/components/billing/billing-summary-store'
import { overageFailureCopy } from '@/components/billing/plan-billing-copy'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import { formatCents } from '@/components/billing/plans/plans-pricing'
import { ORCA_BILLING_OVERAGE_SECTION_ID } from '@/components/new-workspace/orca-cloud-run-target-access'
import type { OrcaBillingOverageResult } from '../../../../shared/orca-billing'
import type { CloudWakeBillingFix } from './cloud-wake-billing'

function openBillingSettings(fix: 'raiseSpendCap' | 'updatePayment'): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({
    pane: 'cloud-billing',
    repoId: null,
    // The spend cap lives on the overage card; the payment notice tops the section already.
    ...(fix === 'raiseSpendCap' ? { sectionId: ORCA_BILLING_OVERAGE_SECTION_ID } : {})
  })
  store.openSettingsPage()
}

export function CloudWakeBillingFixButton({
  fix,
  onRetry
}: {
  fix: CloudWakeBillingFix
  /** Wakes again (after overage is on). */
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [saving, setSaving] = React.useState(false)
  const status = getLastBillingStatus()
  const entitlement = status?.status === 'ok' ? status.entitlement : null
  // Plan numbers come from billing, never guessed (ENTITLEMENTS-C).
  const defaultCapCents = entitlement?.offers?.team.defaultSpendCapCents ?? null
  const maxCapCents = entitlement?.offers?.team.maxSpendCapCents ?? null

  const turnOnOverage = async (): Promise<void> => {
    setSaving(true)
    const outcome = await window.api.orcaProfiles
      .billingSetOverage(
        defaultCapCents === null
          ? { enabled: true }
          : { enabled: true, spendCapCents: defaultCapCents }
      )
      .catch((error: unknown): OrcaBillingOverageResult => ({
        status: 'failed',
        error: String(error)
      }))
    setSaving(false)
    if (outcome.status === 'ok') {
      void refreshBillingSummary(true)
      onRetry()
      return
    }
    toast.error(
      overageFailureCopy(outcome, t, maxCapCents, locale) ??
        t(
          'worktreeCreation.billingBlock.saveFailed',
          'Couldn’t save that. Try again, or change it in Plan & billing.'
        )
    )
  }

  switch (fix) {
    case 'comparePlans':
      return (
        <Button size="sm" onClick={() => openPlansPage('sandbox')}>
          {t('auto.components.billing.comparePlans', 'Compare plans')}
        </Button>
      )
    case 'turnOnOverage':
      return (
        <Button
          size="sm"
          aria-busy={saving || undefined}
          aria-disabled={saving || undefined}
          onClick={saving ? undefined : () => void turnOnOverage()}
        >
          {saving ? <Loader2 className="animate-spin" /> : null}
          {defaultCapCents === null
            ? t('auto.components.billing.overage.turnOnNoCap', 'Turn on overage')
            : t('auto.components.billing.overage.turnOn', 'Turn on with a {{cap}} cap', {
                cap: formatCents(defaultCapCents, locale)
              })}
        </Button>
      )
    case 'raiseSpendCap':
      return (
        <Button size="sm" onClick={() => openBillingSettings('raiseSpendCap')}>
          {t(
            'auto.components.worktree.creation.VmBuildFailureCard.raiseSpendCap',
            'Raise spend cap'
          )}
        </Button>
      )
    case 'updatePayment':
      return (
        <Button size="sm" onClick={() => openBillingSettings('updatePayment')}>
          {t(
            'auto.components.worktree.creation.VmBuildFailureCard.updatePayment',
            'Update payment method'
          )}
        </Button>
      )
  }
}
