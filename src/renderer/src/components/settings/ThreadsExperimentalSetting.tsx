import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSwitch } from './SettingsFormControls'
import type { SettingsSearchEntry } from './settings-search'

export function getThreadsSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('threads.setting.title', 'Threads'),
    description: translate(
      'threads.setting.description',
      'Start a chat in a project without creating a workspace.'
    ),
    keywords: [
      translate('threads.setting.keywords', 'thread chat conversation project experimental')
    ]
  }
}

export function ThreadsExperimentalSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (patch: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getThreadsSearchEntry()
  return (
    <SearchableSetting {...entry} id="experimental-threads" className="space-y-3 py-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>
        <SettingsSwitch
          checked={settings.experimentalThreads === true}
          ariaLabel={entry.title}
          onChange={() => updateSettings({ experimentalThreads: !settings.experimentalThreads })}
        />
      </div>
    </SearchableSetting>
  )
}
