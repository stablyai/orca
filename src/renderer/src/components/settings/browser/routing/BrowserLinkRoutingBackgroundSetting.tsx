import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import {
  getLinkRoutingBackgroundSearchEntry,
  linkRoutingSubRowClass
} from './browser-link-routing-copy'
import { useTranslate } from '../../../../i18n/use-translate'
import { usesHttpLinkMode } from '@/lib/links/preferences/http-link-mode'

type BrowserLinkRoutingBackgroundSettingProps = {
  settings: Pick<GlobalSettings, 'openLinksInAppInBackground'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserLinkRoutingBackgroundSetting({
  settings,
  updateSettings
}: BrowserLinkRoutingBackgroundSettingProps): React.JSX.Element {
  const t = useTranslate()
  const entry = getLinkRoutingBackgroundSearchEntry(t)

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <div className={linkRoutingSubRowClass(usesHttpLinkMode())}>
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
