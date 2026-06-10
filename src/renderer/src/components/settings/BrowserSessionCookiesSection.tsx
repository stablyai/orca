import { Plus } from 'lucide-react'
import type { BrowserSessionProfile } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { BrowserProfileRow, type BrowserProfileRowProps } from './BrowserProfileRow'
import { translate } from '@/i18n/i18n'

type BrowserSessionCookiesSectionProps = {
  defaultProfile: BrowserSessionProfile | undefined
  nonDefaultProfiles: BrowserSessionProfile[]
  detectedBrowsers: BrowserProfileRowProps['detectedBrowsers']
  importState: BrowserProfileRowProps['importState']
  defaultBrowserSessionProfileId: string | null
  onAddProfile: () => void
  onSelectDefaultProfile: () => void
  onSelectProfile: (profileId: string) => void
}

export function BrowserSessionCookiesSection({
  defaultProfile,
  nonDefaultProfiles,
  detectedBrowsers,
  importState,
  defaultBrowserSessionProfileId,
  onAddProfile,
  onSelectDefaultProfile,
  onSelectProfile
}: BrowserSessionCookiesSectionProps): React.JSX.Element {
  return (
    <SearchableSetting
      id="browser-session-cookies"
      title={translate('auto.components.settings.BrowserPane.113cd2dc9b', 'Session & Cookies')}
      description={translate(
        'auto.components.settings.BrowserPane.aa1074bfe9',
        'Manage browser profiles and import cookies from Chrome, Edge, Comet, or other browsers.'
      )}
      keywords={[
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
            )}
            <strong>···</strong>{' '}
            {translate('auto.components.settings.BrowserPane.e4aaf8051b', 'toolbar menu.')}
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={onAddProfile} className="shrink-0 gap-1.5">
          <Plus className="size-3" />
          {translate('auto.components.settings.BrowserPane.6f2584b39e', 'Add Profile')}
        </Button>
      </div>

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
          isActive={(defaultBrowserSessionProfileId ?? 'default') === 'default'}
          onSelect={onSelectDefaultProfile}
          isDefault
        />
        {nonDefaultProfiles.map((profile) => (
          <BrowserProfileRow
            key={profile.id}
            profile={profile}
            detectedBrowsers={detectedBrowsers}
            importState={importState}
            isActive={(defaultBrowserSessionProfileId ?? 'default') === profile.id}
            onSelect={() => onSelectProfile(profile.id)}
          />
        ))}
      </div>
    </SearchableSetting>
  )
}
