import React from 'react'
import { CopyTextButton } from '@/components/clipboard/CopyTextButton'
import { useTranslate } from '@/i18n/use-translate'
import { GOOGLE_PERSONAL_APP_LINKS } from '../../../../../shared/google/google-console-setup'

/** The links a personal app's Branding page needs, each ready to copy. */
export function GoogleBrandingLinks(): React.JSX.Element {
  const t = useTranslate()
  const rows = [
    {
      label: t('bots.google.links.homePage', 'Application home page'),
      value: GOOGLE_PERSONAL_APP_LINKS.homePage
    },
    {
      label: t('bots.google.links.privacyPolicy', 'Application privacy policy link'),
      value: GOOGLE_PERSONAL_APP_LINKS.privacyPolicy
    },
    {
      label: t('bots.google.links.authorizedDomain', 'Authorized domain'),
      value: GOOGLE_PERSONAL_APP_LINKS.authorizedDomain
    }
  ]
  return (
    <div className="space-y-2">
      <dl className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="truncate font-mono text-xs">{row.value}</dd>
            </div>
            <CopyTextButton
              text={row.value}
              label={t('bots.google.links.copy', 'Copy {{label}}', { label: row.label })}
            />
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.google.links.owner',
          'You’re the owner of this Google app; these links just point to Orca.'
        )}
      </p>
    </div>
  )
}
