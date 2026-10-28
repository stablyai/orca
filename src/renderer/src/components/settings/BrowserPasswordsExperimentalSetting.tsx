import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getBrowserPasswordsExperimentalSearchEntry } from './browser-passwords-experimental-search'

export function BrowserPasswordsExperimentalSetting({
  settings,
  updateSettings
}: {
  settings: Pick<GlobalSettings, 'experimentalBrowserPasswords'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getBrowserPasswordsExperimentalSearchEntry()
  const enabled = settings.experimentalBrowserPasswords === true
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="flex items-start justify-between gap-4 py-2"
      id="browser-passwords-experimental"
    >
      <div className="min-w-0 shrink space-y-0.5">
        <Label>{entry.title}</Label>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      </div>
      <SettingsSwitch
        checked={enabled}
        ariaLabel={translate(
          'settings.experimental.browserPasswords.toggle',
          'Toggle saved passwords'
        )}
        onChange={() => updateSettings({ experimentalBrowserPasswords: !enabled })}
      />
    </SearchableSetting>
  )
}
