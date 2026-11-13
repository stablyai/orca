import React from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { useTranslate } from '@/i18n/use-translate'

/**
 * CAP-GATE-DESKTOP: the team has a plan, but Orca Cloud isn't turned on for it. "Try again"
 * re-checks (the page moves on by itself once it is on); "Contact us" opens the catalog's contact
 * target and is hidden when there is none.
 */
export function CloudCapabilityOffActions({
  onTryAgain,
  contactUrl
}: {
  onTryAgain: () => void
  contactUrl: string | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" onClick={onTryAgain}>
        {t('cloudSetupPage.capability.tryAgain', 'Try again')}
      </Button>
      {contactUrl ? (
        <Button type="button" variant="outline" onClick={() => openAppHttpLink(contactUrl)}>
          {t('cloudSetupPage.capability.contact', 'Contact us')}
          <ExternalLink aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}
