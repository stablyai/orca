import { Building2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingOffers } from '../../../../../shared/orca-billing'
import { PlanCardShell } from './PlanCardShell'

export function EnterprisePlanCard({
  enterprise,
  onContactSales
}: {
  enterprise: OrcaBillingOffers['enterprise']
  onContactSales: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <PlanCardShell
      id="plans-enterprise-title"
      title={
        <>
          <Building2 className="size-4 text-muted-foreground" />
          {enterprise.label}
        </>
      }
      price={<p className="text-3xl font-semibold tracking-tight">{enterprise.priceLabel}</p>}
      priceNote={t('auto.components.billing.plans.entPriced', 'Priced for your organization')}
      featuresLead={t('auto.components.billing.plans.entLead', 'Everything in Team, plus:')}
      features={[
        t('auto.components.billing.plans.entByoc', 'Run sandboxes in your own cloud account'),
        t('auto.components.billing.plans.entSso', 'SSO, SCIM provisioning and audit logs'),
        t('auto.components.billing.plans.entNetwork', 'Network policy and egress controls'),
        t('auto.components.billing.plans.entTerms', 'Custom limits, invoicing and terms')
      ]}
      footer={
        <>
          <Button type="button" variant="outline" className="w-full" onClick={onContactSales}>
            {t('auto.components.billing.plans.contactSales', 'Contact sales')}
            <ExternalLink />
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {t(
              'auto.components.billing.plans.entHint',
              'Tell us about your team and where you run.'
            )}
          </p>
        </>
      }
    />
  )
}
