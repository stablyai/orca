import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { getExperimentalSearchEntry } from './experimental-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'

type OffscreenBrowserPagesExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function OffscreenBrowserPagesExperimentalSetting({
  settings,
  updateSettings
}: OffscreenBrowserPagesExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().offscreenBrowserPages
  const enabled = settings.experimentalOffscreenBrowserPages === true

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
      id="offscreen-browser-pages"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-1.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.offscreenBrowserPages.detail',
              'Browser tabs render offscreen and paint into the pane, so an agent clicking or typing in a page never moves focus or interrupts IME composition in your terminal. Applies to tabs opened after the change.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={entry.title}
          onChange={() => updateSettings({ experimentalOffscreenBrowserPages: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
