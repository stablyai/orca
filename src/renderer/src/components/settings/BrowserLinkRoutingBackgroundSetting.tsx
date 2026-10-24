import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getLinkRoutingBackgroundSearchEntry } from './browser-link-routing-copy'

type BrowserLinkRoutingBackgroundSettingProps = {
  settings: Pick<GlobalSettings, 'openLinksInAppInBackground'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserLinkRoutingBackgroundSetting({
  settings,
  updateSettings
}: BrowserLinkRoutingBackgroundSettingProps): React.JSX.Element {
  const entry = getLinkRoutingBackgroundSearchEntry()

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      {/* Nested under Link Routing: it only changes how an Orca-routed link opens. */}
      <div className="ml-4 border-l border-border pl-4">
        <SettingsSwitchRow
          label={entry.title}
          description={entry.description}
          checked={settings.openLinksInAppInBackground === true}
          onChange={() =>
            updateSettings({
              openLinksInAppInBackground: settings.openLinksInAppInBackground !== true
            })
          }
        />
      </div>
    </SearchableSetting>
  )
}
