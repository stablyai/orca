import { Building2, ExternalLink } from 'lucide-react'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { PlanCardShell } from './PlanCardShell'
import { planFeatureLines } from './plan-feature-copy'
import type { EnterprisePlanModel } from './plans-model'

export function EnterprisePlanCard({
  enterprise,
  onContactSales
}: {
  enterprise: EnterprisePlanModel
  onContactSales: (url: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  // Billing's catalog lists what Enterprise adds; an older service lists nothing.
  const features = planFeatureLines(
    enterprise.features,
    { overage: null, currency: 'usd' },
    t,
    locale
  )
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
      price={
        enterprise.priceLabel ? (
          <p className="text-xl font-semibold tracking-tight">{enterprise.priceLabel}</p>
        ) : null
      }
      priceNote={t('auto.components.billing.plans.entPriced2', 'Priced for your team')}
      featuresLead={
        features.length > 0
          ? t('auto.components.billing.plans.entLead', 'Everything in Team, plus:')
          : undefined
      }
      features={features}
      footer={
        contactUrl ? (
          <>
            <OpenExternalSplitButton
              variant="outline"
              groupClassName="w-full"
              className="flex-1"
              link={contactUrl}
              onClick={() => onContactSales(contactUrl)}
            >
              {t('auto.components.billing.plans.contactSales', 'Contact sales')}
              <ExternalLink />
            </OpenExternalSplitButton>
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
