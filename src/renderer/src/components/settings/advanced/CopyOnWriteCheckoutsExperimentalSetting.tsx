import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getCopyOnWriteCheckoutsSearchEntry } from './copy-on-write-checkouts-search'

export function CopyOnWriteCheckoutsExperimentalSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getCopyOnWriteCheckoutsSearchEntry()
  const enabled = settings.experimentalCopyOnWriteCheckouts === true
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="flex items-start justify-between gap-4 py-3"
      id="copy-on-write-checkouts"
    >
      <div className="min-w-0 shrink space-y-0.5">
        <Label>{entry.title}</Label>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      </div>
      <Switch
        checked={enabled}
        aria-label={t(
          'auto.components.settings.copyOnWriteCheckouts.toggleLabel',
          'Toggle copy-on-write workspaces'
        )}
        onCheckedChange={() => updateSettings({ experimentalCopyOnWriteCheckouts: !enabled })}
      />
    </SearchableSetting>
  )
}
