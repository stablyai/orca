import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'

type FitTabsToTitlesExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function FitTabsToTitlesExperimentalSetting({
  settings,
  updateSettings
}: FitTabsToTitlesExperimentalSettingProps): React.JSX.Element {
  const enabled = settings.experimentalFitTabsToTitles === true
  const title = translate(
    'auto.components.settings.ExperimentalPane.fitTabsToTitles.title',
    'Fit tabs to titles'
  )

  return (
    <SearchableSetting
      title={title}
      description={translate(
        'auto.components.settings.ExperimentalPane.fitTabsToTitles.description',
        'Size tabs to their titles instead of a fixed width.'
      )}
      keywords={getExperimentalSearchEntry().fitTabsToTitles.keywords}
      className="space-y-3 py-2"
      id="experimental-fit-tabs-to-titles"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{title}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.fitTabsToTitles.copy',
              'Short titles take less room and long titles get more. Tabs resize when you open, close, move, or rename them, not when an agent or program renames a tab.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.fitTabsToTitles.toggleLabel',
            'Toggle fit tabs to titles'
          )}
          onChange={() => updateSettings({ experimentalFitTabsToTitles: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
