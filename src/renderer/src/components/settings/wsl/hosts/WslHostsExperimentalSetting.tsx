import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { Switch } from '@/components/ui/switch'
import { getWslHostsExperimentalSearchEntry } from './wsl-hosts-experimental-search'
import { useWslHostServerFilesMissing } from '../../../sidebar/use-wsl-hosts-enabled'
import { getWslHostServerFilesMissingLabel } from '../../../sidebar/wsl-host-row-status'

export function WslHostsExperimentalSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getWslHostsExperimentalSearchEntry()
  const enabled = settings.experimentalWslHosts === true
  const serverFilesMissing = useWslHostServerFilesMissing()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="flex items-start justify-between gap-4 py-3"
      id="wsl-hosts"
    >
      <div className="min-w-0 shrink space-y-0.5">
        <Label>{entry.title}</Label>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
        {serverFilesMissing ? (
          <p className="text-xs text-destructive">{getWslHostServerFilesMissingLabel(t)}</p>
        ) : null}
      </div>
      <Switch
        checked={enabled}
        aria-label={t(
          'auto.components.settings.wslHostsExperimental.toggleLabel',
          'Toggle WSL distros as hosts'
        )}
        onCheckedChange={() => updateSettings({ experimentalWslHosts: !enabled })}
      />
    </SearchableSetting>
  )
}
