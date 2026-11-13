// The one locked state for everything on Settings › Enterprise: what the feature is, that it is
// part of Enterprise, and Contact sales. The button opens the page; its chevron copies the link.
import { ExternalLink } from 'lucide-react'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { useTranslate } from '@/i18n/use-translate'

/** Where Contact sales goes when billing has not answered yet (billing's own Enterprise page). */
export const ENTERPRISE_CONTACT_URL = 'https://orca.dev/enterprise'

/** Billing's name and contact page for the plan, so the upsell never drifts from the plans page. */
export type EnterpriseContact = { planName: string; contactUrl: string }

export function EnterpriseUpsell({
  title,
  body,
  contact,
  onContactSales
}: {
  /** "Audit log is part of Enterprise". */
  title: string
  body: string
  contact: EnterpriseContact
  onContactSales: (url: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div data-settings-row="" className="flex flex-wrap items-center gap-3 py-4">
      <div className="min-w-[14rem] flex-1 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground text-pretty">{body}</p>
      </div>
      <OpenExternalSplitButton
        variant="outline"
        size="sm"
        link={contact.contactUrl}
        onClick={() => onContactSales(contact.contactUrl)}
      >
        {t('auto.components.billing.enterpriseContactSales', 'Contact sales')}
        <ExternalLink />
      </OpenExternalSplitButton>
    </div>
  )
}

/** The locked state without a button, for a block under the page banner that carries Contact sales. */
export function EnterpriseUpsellLine({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p data-settings-row="" className="py-4 text-xs text-muted-foreground text-pretty">
      {children}
    </p>
  )
}
