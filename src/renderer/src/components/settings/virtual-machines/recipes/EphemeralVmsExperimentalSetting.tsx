import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../../ui/label'
import { EphemeralVmsPane } from './EphemeralVmsPane'
import { getExperimentalSearchEntry } from '../../advanced/experimental-search'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { Switch } from '@/components/ui/switch'

type EphemeralVmsExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EphemeralVmsExperimentalSetting({
  settings,
  updateSettings
}: EphemeralVmsExperimentalSettingProps): React.JSX.Element {
  const t = useTranslate()
  const entry = getExperimentalSearchEntry().ephemeralVms
  const enabled = settings.experimentalEphemeralVms === true

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="max-w-none space-y-4 py-3"
      id="ephemeral-vms"
    >
      <div className="flex max-w-3xl items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.ephemeralVmsExperimentalSetting.description',
              'Shows setup controls and workspace run targets for repo-owned, on-demand environments.'
            )}
          </p>
        </div>
        <Switch
          checked={enabled}
          aria-label={t(
            'auto.components.settings.ephemeralVmsExperimentalSetting.cloudVmToggleLabel',
            'Toggle Cloud VM'
          )}
          onCheckedChange={() => updateSettings({ experimentalEphemeralVms: !enabled })}
        />
      </div>
      {enabled ? <EphemeralVmsPane /> : null}
    </SearchableSetting>
  )
}
