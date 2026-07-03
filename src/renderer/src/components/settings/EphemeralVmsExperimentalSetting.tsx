import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { EphemeralVmsPane } from './EphemeralVmsPane'
import { getExperimentalSearchEntry } from './experimental-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'

type EphemeralVmsExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EphemeralVmsExperimentalSetting({
  settings,
  updateSettings
}: EphemeralVmsExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().ephemeralVms
  const enabled = settings.experimentalEphemeralVms === true

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="max-w-none space-y-4 py-2"
      id="ephemeral-vms"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.ephemeralVms.search.title',
              'Per-Workspace Environments'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ephemeralVmsExperimentalSetting.description',
              'Shows setup controls and workspace run targets for repo-owned, on-demand environments.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ephemeralVmsExperimentalSetting.toggleLabel',
            'Toggle per-workspace environments'
          )}
          onChange={() => updateSettings({ experimentalEphemeralVms: !enabled })}
        />
      </div>
      {enabled ? <EphemeralVmsPane /> : null}
    </SearchableSetting>
  )
}
