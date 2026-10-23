import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getWslHostsExperimentalSearchEntry } from './wsl-hosts-experimental-search'
import { useWslHostServerFilesMissing } from '../sidebar/use-wsl-hosts-enabled'
import { getWslHostServerFilesMissingLabel } from '../sidebar/wsl-host-row-status'

export function WslHostsExperimentalSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getWslHostsExperimentalSearchEntry()
  const enabled = settings.experimentalWslHosts === true
  const serverFilesMissing = useWslHostServerFilesMissing()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="flex items-start justify-between gap-4 py-2"
      id="wsl-hosts"
    >
      <div className="min-w-0 shrink space-y-0.5">
        <Label>{entry.title}</Label>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
        {serverFilesMissing ? (
          <p className="text-xs text-destructive">{getWslHostServerFilesMissingLabel()}</p>
        ) : null}
      </div>
      <SettingsSwitch
        checked={enabled}
        ariaLabel={translate(
          'auto.components.settings.wslHostsExperimental.toggleLabel',
          'Toggle WSL distros as hosts'
        )}
        onChange={() => updateSettings({ experimentalWslHosts: !enabled })}
      />
    </SearchableSetting>
  )
}
