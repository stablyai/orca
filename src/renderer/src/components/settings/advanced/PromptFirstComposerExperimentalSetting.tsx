import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getPromptFirstComposerSearchEntry } from './prompt-first-composer-experimental-search-entry'

type PromptFirstComposerExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function PromptFirstComposerExperimentalSetting({
  settings,
  updateSettings
}: PromptFirstComposerExperimentalSettingProps): React.JSX.Element {
  const t = useTranslate()
  const enabled = settings.promptFirstComposer === true
  const entry = getPromptFirstComposerSearchEntry()

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-3"
      id="experimental-prompt-first-composer"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>
        <Switch
          aria-label={t(
            'auto.components.settings.ExperimentalPane.promptFirstComposer.toggleLabel',
            'Toggle starting new workspaces from a prompt'
          )}
          checked={enabled}
          onCheckedChange={(checked) => updateSettings({ promptFirstComposer: checked })}
        />
      </div>
    </SearchableSetting>
  )
}
