import { useGoogleCookieClear } from '../use-google-cookie-clear'
import { Plus } from 'lucide-react'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { BrowserProfileRow, type BrowserProfileRowProps } from './BrowserProfileRow'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

type BrowserSessionHostOption = {
  id: ExecutionHostId
  label: string
  detail: string
}

type BrowserSessionCookiesSectionProps = {
  defaultProfile: BrowserSessionProfile | undefined
  nonDefaultProfiles: BrowserSessionProfile[]
  detectedBrowsers: BrowserProfileRowProps['detectedBrowsers']
  importState: BrowserProfileRowProps['importState']
  hostOptions: readonly BrowserSessionHostOption[]
  selectedHostId: ExecutionHostId
  activeProfileId: string
  onAddProfile: () => void
  onSelectHost: (hostId: ExecutionHostId) => void
  onSelectDefaultProfile: () => void
  onSelectProfile: (profileId: string) => void
}

export function BrowserSessionCookiesSection({
  defaultProfile,
  nonDefaultProfiles,
  detectedBrowsers,
  importState,
  hostOptions,
  selectedHostId,
  activeProfileId,
  onAddProfile,
  onSelectHost,
  onSelectDefaultProfile,
  onSelectProfile
}: BrowserSessionCookiesSectionProps): React.JSX.Element {
  const activeProfile = [defaultProfile, ...nonDefaultProfiles].find(
    (profile) => profile?.id === activeProfileId
  )
  const googleCookieClear = useGoogleCookieClear(
    selectedHostId,
    activeProfileId,
    activeProfile?.label
  )
  const selectedHost = hostOptions.find((host) => host.id === selectedHostId) ?? hostOptions[0]
  return (
    <SearchableSetting
      id="browser-session-cookies"
      title={translate('auto.components.settings.BrowserPane.113cd2dc9b', 'Session & Cookies')}
      description={translate(
        'auto.components.settings.BrowserPane.aa1074bfe9',
        'Manage browser profiles and import cookies from Chrome, Edge, Comet, or other browsers.'
      )}
      keywords={[
        ...translateSearchKeyword('auto.components.settings.browser.search.8a489aab8d', 'google'),
        ...translateSearchKeyword('browser.googleCookieClear.signInKeyword', 'sign-in'),
        'cookies',
        'session',
        'import',
        'auth',
        'login',
        'chrome',
        'edge',
        'arc',
        'profile'
      ]}
      className="space-y-3 py-2"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label>
            {translate('auto.components.settings.BrowserPane.2d66a6efb5', 'Session & Cookies')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.BrowserPane.cd47bc9622',
              'Select a default profile for new browser tabs. Import cookies and switch profiles per-tab via the'
            )}{' '}
            <strong>···</strong>{' '}
            {translate('auto.components.settings.BrowserPane.e4aaf8051b', 'toolbar menu.')}
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={onAddProfile} className="shrink-0 gap-1.5">
          <Plus className="size-3" />
          {translate('auto.components.settings.BrowserPane.6f2584b39e', 'Add Profile')}
        </Button>
      </div>

      {hostOptions.length > 1 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
          <div className="min-w-0 space-y-0.5">
            <Label className="text-xs">
              {translate('auto.components.settings.BrowserPane.5e19a692f7', 'Host')}
            </Label>
            <p className="truncate text-[11px] text-muted-foreground">
              {selectedHost?.detail ??
                translate(
                  'auto.components.settings.BrowserPane.6480776a03',
                  'Browser profiles for the selected host.'
                )}
            </p>
          </div>
          <Select
            value={selectedHostId}
            onValueChange={(value) => onSelectHost(value as ExecutionHostId)}
          >
            <SelectTrigger size="sm" className="max-w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {hostOptions.map((host) => (
                <SelectItem key={host.id} value={host.id}>
                  {host.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-2">
        <BrowserProfileRow
          profile={
            defaultProfile ?? {
              id: 'default',
              scope: 'default',
              partition: '',
              label: translate('auto.components.settings.BrowserPane.4399c77caa', 'Default'),
              source: null
            }
          }
          detectedBrowsers={detectedBrowsers}
          importState={importState}
          isActive={activeProfileId === 'default'}
          onSelect={onSelectDefaultProfile}
          isDefault
        />
        {nonDefaultProfiles.map((profile) => (
          <BrowserProfileRow
            key={profile.id}
            profile={profile}
            detectedBrowsers={detectedBrowsers}
            importState={importState}
            isActive={activeProfileId === profile.id}
            onSelect={() => onSelectProfile(profile.id)}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 pt-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{translate('browser.googleCookieClear.heading', 'Google Cookies')}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'browser.googleCookieClear.explanation',
              "Google ties its sign-ins to the browser they were made in, so Orca doesn't import Google cookies from other browsers. If Google is stuck on the wrong account or keeps signing you out, clear Google cookies from the active profile, then sign in to Google again in Orca. Other sites stay signed in."
            )}
          </p>
          {googleCookieClear.available === false ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'browser.googleCookieClear.unavailable',
                'Unavailable for this profile on the selected host.'
              )}
            </p>
          ) : null}
        </div>
        <Button
          variant="destructive"
          size="xs"
          className="shrink-0"
          disabled={!googleCookieClear.available || googleCookieClear.busy}
          onClick={() => void googleCookieClear.onClick()}
        >
          {translate('browser.googleCookieClear.action', 'Clear Google cookies…')}
        </Button>
      </div>
    </SearchableSetting>
  )
}
