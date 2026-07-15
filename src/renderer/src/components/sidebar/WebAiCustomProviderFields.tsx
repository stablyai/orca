import { useMemo } from 'react'
import {
  normalizeCustomWebAiHomeUrl,
  type NormalizedCustomWebAiAccountFields
} from '../../../../shared/web-ai-accounts'
import { deriveBrowserCookieDomainsFromHomeUrl } from '../../../../shared/browser-cookie-import-scope'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

type WebAiCustomProviderFieldsProps = {
  serviceLabel: string
  homeUrl: string
  cookieDomains: string
  normalizedFields: NormalizedCustomWebAiAccountFields | null
  onServiceLabelChange: (value: string) => void
  onHomeUrlChange: (value: string) => void
  onCookieDomainsChange: (value: string) => void
}

export function WebAiCustomProviderFields({
  serviceLabel,
  homeUrl,
  cookieDomains,
  normalizedFields,
  onServiceLabelChange,
  onHomeUrlChange,
  onCookieDomainsChange
}: WebAiCustomProviderFieldsProps): React.JSX.Element {
  const normalizedHomeUrl = normalizeCustomWebAiHomeUrl(homeUrl)
  const derivedCookieDomains = useMemo(
    () => deriveBrowserCookieDomainsFromHomeUrl(homeUrl) ?? [],
    [homeUrl]
  )
  const homeUrlInvalid = Boolean(homeUrl.trim() && !normalizedHomeUrl)
  const cookieDomainsInvalid = Boolean(
    cookieDomains.trim() && serviceLabel.trim() && normalizedHomeUrl && !normalizedFields
  )

  return (
    <div className="space-y-3">
      <div className="grid gap-1.5">
        <Label htmlFor="web-ai-custom-service-label">
          {translate(
            'auto.components.sidebar.WebAiAccountDialog.customServiceLabel',
            'Service name'
          )}
        </Label>
        <Input
          id="web-ai-custom-service-label"
          value={serviceLabel}
          onChange={(event) => onServiceLabelChange(event.target.value)}
          maxLength={80}
          placeholder={translate(
            'auto.components.sidebar.WebAiAccountDialog.customServiceLabelPlaceholder',
            'Doubao'
          )}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="web-ai-custom-home-url">
          {translate('auto.components.sidebar.WebAiAccountDialog.customHomeUrl', 'Home URL')}
        </Label>
        <Input
          id="web-ai-custom-home-url"
          type="url"
          inputMode="url"
          value={homeUrl}
          onChange={(event) => onHomeUrlChange(event.target.value)}
          aria-invalid={homeUrlInvalid || undefined}
          placeholder={translate(
            'auto.components.sidebar.WebAiAccountDialog.customHomeUrlPlaceholder',
            'https://www.doubao.com/'
          )}
        />
        <p
          className={
            homeUrlInvalid ? 'text-[11px] text-destructive' : 'text-[11px] text-muted-foreground'
          }
        >
          {homeUrlInvalid
            ? translate(
                'auto.components.sidebar.WebAiAccountDialog.customHomeUrlInvalid',
                'Enter an HTTPS URL without a username or password.'
              )
            : translate(
                'auto.components.sidebar.WebAiAccountDialog.customHomeUrlHint',
                'This reusable home page is saved without query parameters or fragments.'
              )}
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="web-ai-custom-cookie-domains">
          {translate(
            'auto.components.sidebar.WebAiAccountDialog.customCookieDomains',
            'Cookie domains'
          )}
        </Label>
        <Input
          id="web-ai-custom-cookie-domains"
          value={cookieDomains}
          onChange={(event) => onCookieDomainsChange(event.target.value)}
          aria-invalid={cookieDomainsInvalid || undefined}
          placeholder={
            derivedCookieDomains.join(', ') ||
            translate(
              'auto.components.sidebar.WebAiAccountDialog.customCookieDomainsPlaceholder',
              'doubao.com'
            )
          }
        />
        <p
          className={
            cookieDomainsInvalid
              ? 'text-[11px] text-destructive'
              : 'text-[11px] text-muted-foreground'
          }
        >
          {cookieDomainsInvalid
            ? translate(
                'auto.components.sidebar.WebAiAccountDialog.customCookieDomainsInvalid',
                'Use comma-separated domains that are the home hostname or one of its parent domains.'
              )
            : derivedCookieDomains.length > 0
              ? translate(
                  'auto.components.sidebar.WebAiAccountDialog.customCookieDomainsDerived',
                  'Leave blank to use {{value0}}. Separate multiple domains with commas.',
                  { value0: derivedCookieDomains.join(', ') }
                )
              : translate(
                  'auto.components.sidebar.WebAiAccountDialog.customCookieDomainsHint',
                  'Separate multiple domains with commas. Protocols, paths, and wildcards are not allowed.'
                )}
        </p>
      </div>
    </div>
  )
}
