import { useGoogleCookieClear } from './use-google-cookie-clear'
import { useProfileCookieClear } from './use-profile-cookie-clear'
import type { BrowserSessionHostOption } from './browser-session-host-selection'
import { translateBrowserSessionProfileLabel } from '@/lib/browser/profiles/browser-session-profile-label'
import { Plus } from 'lucide-react'
import type { BrowserSessionProfile } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { BrowserProfileRow, type BrowserProfileRowProps } from './BrowserProfileRow'
import { BrowserProfileSiteList } from './BrowserProfileSiteList'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { useTranslate } from '@/i18n/use-translate'
import { translateSearchKeyword } from '../../search/settings-search-keywords'

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
  const t = useTranslate()
  const activeProfile = [defaultProfile, ...nonDefaultProfiles].find(
    (profile) => profile?.id === activeProfileId
  )
  const googleCookieClear = useGoogleCookieClear(
    selectedHostId,
    activeProfileId,
    activeProfile?.label
  )
  const selectedHost = hostOptions.find((host) => host.id === selectedHostId) ?? hostOptions[0]
  const shownDefaultProfile: BrowserSessionProfile = defaultProfile ?? {
    id: 'default',
    scope: 'default',
    partition: '',
    label: t('auto.components.settings.BrowserPane.4399c77caa', 'Default'),
    source: null
  }
  const parsedSelectedHost = parseExecutionHostId(selectedHost?.id)
  const sshRoute =
    parsedSelectedHost?.kind === 'ssh' && selectedHost
      ? { sshTargetId: parsedSelectedHost.targetId, hostLabel: selectedHost.label }
      : null
  const profileCookieClear = useProfileCookieClear(
    selectedHost ?? { id: selectedHostId, kind: 'local', label: '' },
    activeProfileId,
    translateBrowserSessionProfileLabel(
      activeProfile?.label || (activeProfileId === 'default' ? 'Default' : 'Browser profile'),
      activeProfileId
    )
  )
  return (
    <SearchableSetting
      id="browser-session-cookies"
      title={t('auto.components.settings.BrowserPane.bc44903d30', 'Session & cookies')}
      description={t(
        'auto.components.settings.BrowserPane.aa1074bfe9',
        'Manage browser profiles and import cookies from Chrome, Edge, Comet, or other browsers.'
      )}
      keywords={[
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.8a489aab8d',
          'google',
          undefined,
          t
        ),
        ...translateSearchKeyword(
          'browser.googleCookieClear.signInKeyword',
          'sign-in',
          undefined,
          t
        ),
        ...translateSearchKeyword('browser.siteList.label', 'Site list', undefined, t),
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
      className="space-y-3 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label>{t('auto.components.settings.BrowserPane.ddd634b250', 'Session & cookies')}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.BrowserPane.cd47bc9622',
              'Select a default profile for new browser tabs. Import cookies and switch profiles per-tab via the'
            )}{' '}
            <strong>···</strong>{' '}
            {t('auto.components.settings.BrowserPane.e4aaf8051b', 'toolbar menu.')}
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={onAddProfile} className="shrink-0 gap-1.5">
          <Plus className="size-3" />
          {t('auto.components.settings.BrowserPane.549f28cf10', 'Add profile')}
        </Button>
      </div>

      {hostOptions.length > 1 ? (
        <div
          data-settings-row=""
          className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2"
        >
          <div className="min-w-0 space-y-0.5">
            <Label className="text-xs">
              {t('auto.components.settings.BrowserPane.5e19a692f7', 'Host')}
            </Label>
            <p className="truncate text-[11px] text-muted-foreground">
              {selectedHost?.detail ??
                t(
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
                  {host.kind === 'ssh'
                    ? t('browser.profileCookieClear.sshHostOption', '{{host}} (SSH)', {
                        host: host.label
                      })
                    : host.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-2">
        <BrowserProfileRow
          profile={shownDefaultProfile}
          detectedBrowsers={detectedBrowsers}
          importState={importState}
          isActive={activeProfileId === 'default'}
          onSelect={onSelectDefaultProfile}
          sshRoute={sshRoute}
        />
        {nonDefaultProfiles.map((profile) => (
          <BrowserProfileRow
            key={profile.id}
            profile={profile}
            detectedBrowsers={detectedBrowsers}
            importState={importState}
            isActive={activeProfileId === profile.id}
            onSelect={() => onSelectProfile(profile.id)}
            sshRoute={sshRoute}
          />
        ))}
      </div>
      {selectedHostId === LOCAL_EXECUTION_HOST_ID ? (
        <BrowserProfileSiteList profiles={[shownDefaultProfile, ...nonDefaultProfiles]} />
      ) : null}
      <div className="flex items-center justify-between gap-3 pt-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{t('browser.profileCookieClear.label', 'Cookies')}</Label>
          <p className="text-xs text-muted-foreground">{profileCookieClear.rowText}</p>
          {profileCookieClear.available ? null : (
            <p className="text-xs text-muted-foreground">
              {t(
                'browser.profileCookieClear.unavailable',
                'Unavailable for this profile on the selected host.'
              )}
            </p>
          )}
        </div>
        <Button
          variant="destructive"
          size="xs"
          className="shrink-0"
          disabled={!profileCookieClear.available || profileCookieClear.busy}
          onClick={() => void profileCookieClear.onClick()}
        >
          {t('browser.profileCookieClear.action', 'Clear cookies…')}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3 pt-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{t('browser.googleCookieClear.fe3f6e1721', 'Google cookies')}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'browser.googleCookieClear.explanation',
              "Google ties its sign-ins to the browser they were made in, so Orca doesn't import Google cookies from other browsers. If Google is stuck on the wrong account or keeps signing you out, clear Google cookies from the active profile, then sign in to Google again in Orca. Other sites stay signed in."
            )}
          </p>
          {googleCookieClear.available === false ? (
            <p className="text-xs text-muted-foreground">
              {t(
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
          {t('browser.googleCookieClear.action', 'Clear Google cookies…')}
        </Button>
      </div>
    </SearchableSetting>
  )
}
