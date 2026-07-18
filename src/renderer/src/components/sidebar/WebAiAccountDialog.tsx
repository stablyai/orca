import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BrowserSessionProfile, WebAiProvider } from '../../../../shared/types'
import {
  WEB_AI_PROVIDERS,
  getWebAiProvider,
  normalizeCustomWebAiAccountFields
} from '../../../../shared/web-ai-accounts'
import { isGoogleCookieImportScope } from '../../../../shared/browser-cookie-import-scope'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { WebAiAccountDraft } from './web-ai-account-draft'
import { WebAiCustomProviderFields } from './WebAiCustomProviderFields'

export type { WebAiAccountDraft } from './web-ai-account-draft'

const NEW_PROFILE_VALUE = '__new_profile__'

type WebAiAccountDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  profiles: BrowserSessionProfile[]
  submitting: boolean
  onSubmit: (draft: WebAiAccountDraft) => void
}

export function WebAiAccountDialog({
  open,
  onOpenChange,
  profiles,
  submitting,
  onSubmit
}: WebAiAccountDialogProps): React.JSX.Element {
  useTranslation()
  const [provider, setProvider] = useState<WebAiProvider>('chatgpt')
  const [label, setLabel] = useState(getWebAiProvider('chatgpt').label)
  const [profileChoice, setProfileChoice] = useState(NEW_PROFILE_VALUE)
  const [customServiceLabel, setCustomServiceLabel] = useState('')
  const [customHomeUrl, setCustomHomeUrl] = useState('')
  const [customCookieDomains, setCustomCookieDomains] = useState('')

  useEffect(() => {
    if (!open) {
      return
    }
    setProvider('chatgpt')
    setLabel(getWebAiProvider('chatgpt').label)
    setProfileChoice(NEW_PROFILE_VALUE)
    setCustomServiceLabel('')
    setCustomHomeUrl('')
    setCustomCookieDomains('')
  }, [open])

  const handleProviderChange = (nextValue: string): void => {
    const nextProvider = nextValue as WebAiProvider
    const currentDefaultLabel =
      provider === 'custom'
        ? customServiceLabel.trim() || getWebAiProvider('custom').label
        : getWebAiProvider(provider).label
    const nextDefaultLabel =
      nextProvider === 'custom'
        ? customServiceLabel.trim() || getWebAiProvider('custom').label
        : getWebAiProvider(nextProvider).label
    setProvider(nextProvider)
    setLabel((current) =>
      !current.trim() || current.trim() === currentDefaultLabel ? nextDefaultLabel : current
    )
  }

  const customFields = useMemo(
    () =>
      provider === 'custom'
        ? normalizeCustomWebAiAccountFields({
            customServiceLabel,
            customHomeUrl,
            customCookieDomains
          })
        : null,
    [customCookieDomains, customHomeUrl, customServiceLabel, provider]
  )
  const providerDefinition = getWebAiProvider(provider)
  const effectiveCookieDomains =
    provider === 'custom' ? customFields?.customCookieDomains : providerDefinition.cookieDomains
  const sharedGoogleCookieServiceLabel =
    effectiveCookieDomains && isGoogleCookieImportScope({ domains: effectiveCookieDomains })
      ? provider === 'custom'
        ? customFields?.customServiceLabel
        : providerDefinition.label
      : null
  const canSubmit =
    Boolean(label.trim()) && !submitting && (provider !== 'custom' || customFields !== null)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && submitting) {
          return
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg scrollbar-sleek"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="text-base">
            {translate('auto.components.sidebar.WebAiAccountDialog.title', 'Add Web AI Account')}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmedLabel = label.trim()
            if (!trimmedLabel || submitting) {
              return
            }
            const profileId = profileChoice === NEW_PROFILE_VALUE ? null : profileChoice
            if (provider === 'custom') {
              if (!customFields) {
                return
              }
              onSubmit({ provider, label: trimmedLabel, profileId, ...customFields })
              return
            }
            onSubmit({ provider, label: trimmedLabel, profileId })
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="web-ai-provider">
              {translate('auto.components.sidebar.WebAiAccountDialog.provider', 'Service')}
            </Label>
            <Select value={provider} onValueChange={handleProviderChange}>
              <SelectTrigger id="web-ai-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEB_AI_PROVIDERS.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {provider === 'custom' ? (
            <WebAiCustomProviderFields
              serviceLabel={customServiceLabel}
              homeUrl={customHomeUrl}
              cookieDomains={customCookieDomains}
              normalizedFields={customFields}
              onServiceLabelChange={(nextValue) => {
                const previousDefaultLabel =
                  customServiceLabel.trim() || getWebAiProvider('custom').label
                setCustomServiceLabel(nextValue)
                setLabel((current) =>
                  !current.trim() || current.trim() === previousDefaultLabel
                    ? nextValue.trim() || getWebAiProvider('custom').label
                    : current
                )
              }}
              onHomeUrlChange={setCustomHomeUrl}
              onCookieDomainsChange={setCustomCookieDomains}
            />
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="web-ai-account-label">
              {translate('auto.components.sidebar.WebAiAccountDialog.accountName', 'Account name')}
            </Label>
            <Input
              id="web-ai-account-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
              autoFocus
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="web-ai-browser-profile">
              {translate(
                'auto.components.sidebar.WebAiAccountDialog.browserProfile',
                'Browser profile'
              )}
            </Label>
            <Select value={profileChoice} onValueChange={setProfileChoice}>
              <SelectTrigger id="web-ai-browser-profile" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW_PROFILE_VALUE}>
                  {translate(
                    'auto.components.sidebar.WebAiAccountDialog.createProfile',
                    'Create a new isolated profile'
                  )}
                </SelectItem>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {sharedGoogleCookieServiceLabel ? (
            <DialogDescription className="flex items-start gap-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {translate(
                  'auto.components.sidebar.WebAiAccountDialog.sharedGoogleCookiesWarning',
                  '{{value0}} uses shared google.com sign-in cookies. Google sign-in may reject embedded browsers, and importing cookies can change the Google account used by other Google services in this browser profile.',
                  { value0: sharedGoogleCookieServiceLabel }
                )}
              </span>
            </DialogDescription>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {translate('auto.components.sidebar.WebAiAccountDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {translate('auto.components.sidebar.WebAiAccountDialog.addAndOpen', 'Add and open')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
