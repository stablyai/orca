import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { getLinkRoutingSplitSearchEntry } from './browser-link-routing-copy'
import { useTranslate } from '../../../../i18n/use-translate'

type BrowserLinkRoutingSplitSettingProps = {
  settings: Pick<GlobalSettings, 'openLinksInAppInSplit'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserLinkRoutingSplitSetting({
  settings,
  updateSettings
}: BrowserLinkRoutingSplitSettingProps): React.JSX.Element {
  const t = useTranslate()
  const entry = getLinkRoutingSplitSearchEntry(t)

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
          checked={settings.openLinksInAppInSplit !== false}
          onChange={() =>
            updateSettings({
              openLinksInAppInSplit: settings.openLinksInAppInSplit === false
            })
          }
        />
      </div>
    </SearchableSetting>
  )
}
