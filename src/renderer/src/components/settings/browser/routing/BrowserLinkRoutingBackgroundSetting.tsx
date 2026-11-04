import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import type { SettingsSearchEntry } from '../../search/settings-search'
import {
  getLinkRoutingBackgroundSearchEntry,
  getLinkRoutingExistingTabSearchEntry
} from './browser-link-routing-copy'

type BrowserLinkOpeningToggleKey = 'openLinksInAppInBackground' | 'openLinksInExistingBrowserTab'

type BrowserLinkOpeningToggleProps<Key extends BrowserLinkOpeningToggleKey> = {
  settings: Pick<GlobalSettings, Key>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function BrowserLinkOpeningToggle({
  entry,
  checked,
  onToggle
}: {
  entry: SettingsSearchEntry
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
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
          checked={checked}
          onChange={onToggle}
        />
      </div>
    </SearchableSetting>
  )
}

export function BrowserLinkRoutingBackgroundSetting({
  settings,
  updateSettings
}: BrowserLinkOpeningToggleProps<'openLinksInAppInBackground'>): React.JSX.Element {
  return (
    <BrowserLinkOpeningToggle
      entry={getLinkRoutingBackgroundSearchEntry()}
      checked={settings.openLinksInAppInBackground === true}
      onToggle={() =>
        updateSettings({
          openLinksInAppInBackground: settings.openLinksInAppInBackground !== true
        })
      }
    />
  )
}

export function BrowserLinkRoutingExistingTabSetting({
  settings,
  updateSettings
}: BrowserLinkOpeningToggleProps<'openLinksInExistingBrowserTab'>): React.JSX.Element {
  return (
    <BrowserLinkOpeningToggle
      entry={getLinkRoutingExistingTabSearchEntry()}
      checked={settings.openLinksInExistingBrowserTab === true}
      onToggle={() =>
        updateSettings({
          openLinksInExistingBrowserTab: settings.openLinksInExistingBrowserTab !== true
        })
      }
    />
  )
}
