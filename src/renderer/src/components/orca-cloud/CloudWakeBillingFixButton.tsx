// The one fix on a refused wake's card, for an owner or admin, with the create sheet's labels:
// every fix is made in the browser (the web console's billing page); the card's Try again wakes
// again once it's done.
import React from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'
import type { CloudWakeBillingFix } from './cloud-wake-billing'

export function CloudWakeBillingFixButton({
  fix
}: {
  fix: CloudWakeBillingFix
}): React.JSX.Element {
  const t = useTranslate()
  const openBilling = (): void => void openCloudConsole('billing')
  switch (fix) {
    case 'comparePlans':
      return (
        <Button size="sm" onClick={openBilling}>
          {t('auto.components.billing.comparePlans', 'Compare plans')}
        </Button>
      )
    case 'turnOnOverage':
      return (
        <Button size="sm" onClick={openBilling}>
          {t('worktreeCreation.billingBlock.turnOnInBrowser', 'Turn on in browser')}
          <ExternalLink />
        </Button>
      )
    case 'raiseSpendCap':
      return (
        <Button size="sm" onClick={openBilling}>
          {t('worktreeCreation.billingBlock.raiseInBrowser', 'Raise in browser')}
          <ExternalLink />
        </Button>
      )
    case 'updatePayment':
      return (
        <Button size="sm" onClick={openBilling}>
          {t('worktreeCreation.billingBlock.updateInBrowser', 'Update in browser')}
          <ExternalLink />
        </Button>
      )
  }
}
