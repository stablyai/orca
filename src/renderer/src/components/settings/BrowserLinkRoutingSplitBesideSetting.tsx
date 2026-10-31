import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getLinkRoutingSplitBesideSearchEntry } from './browser-link-routing-copy'

type BrowserLinkRoutingSplitBesideSettingProps = {
  settings: Pick<GlobalSettings, 'openLinksInAppSplitBeside'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Link Routing switch that chooses between splitting beside the clicked pane and opening a tab in it. */
export function BrowserLinkRoutingSplitBesideSetting({
  settings,
  updateSettings
}: BrowserLinkRoutingSplitBesideSettingProps): React.JSX.Element {
  const entry = getLinkRoutingSplitBesideSearchEntry()

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <div className="ml-4 border-l border-border pl-4">
        <SettingsSwitchRow
          label={entry.title}
          description={entry.description}
          checked={settings.openLinksInAppSplitBeside !== false}
          onChange={() =>
            updateSettings({
              openLinksInAppSplitBeside: settings.openLinksInAppSplitBeside === false
            })
          }
        />
      </div>
    </SearchableSetting>
  )
}
