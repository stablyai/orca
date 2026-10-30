import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getPromptFirstComposerSearchEntry } from './prompt-first-composer-experimental-search-entry'

type PromptFirstComposerExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function PromptFirstComposerExperimentalSetting({
  settings,
  updateSettings
}: PromptFirstComposerExperimentalSettingProps): React.JSX.Element {
  const enabled = settings.promptFirstComposer === true
  const entry = getPromptFirstComposerSearchEntry()

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
      id="experimental-prompt-first-composer"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.promptFirstComposer.toggleLabel',
            'Toggle starting new workspaces from a prompt'
          )}
          onChange={() => updateSettings({ promptFirstComposer: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
