import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'

type OrchestrationPanelExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function OrchestrationPanelExperimentalSetting({
  settings,
  updateSettings
}: OrchestrationPanelExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().orchestrationPanel
  const enabled = settings.experimentalOrchestrationPanel === true

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
      id="experimental-orchestration-panel"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.orchestrationPanel.toggleLabel',
            'Toggle orchestration panel'
          )}
          onChange={() => updateSettings({ experimentalOrchestrationPanel: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
