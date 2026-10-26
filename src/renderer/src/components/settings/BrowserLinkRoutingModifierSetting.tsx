import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getLinkRoutingModifierDescription,
  getLinkRoutingModifierTitle
} from './browser-link-routing-copy'

type BrowserLinkRoutingModifierSettingProps = {
  settings: Pick<GlobalSettings, 'openLinksInApp' | 'openLinksInAppModifierInverts'>
  /** Installed browser that external opens use; null means the OS default. */
  externalBrowserName: string | null
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserLinkRoutingModifierSetting({
  settings,
  externalBrowserName,
  isMac,
  updateSettings
}: BrowserLinkRoutingModifierSettingProps): React.JSX.Element {
  const openLinksInApp = settings.openLinksInApp === true
  const title = getLinkRoutingModifierTitle(openLinksInApp, externalBrowserName)
  const description = getLinkRoutingModifierDescription({
    openLinksInApp,
    isMac,
    externalBrowserName
  })

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'browser',
        'links',
        'routing',
        'shift',
        'modifier',
        'invert',
        'opposite',
        isMac ? 'cmd' : 'ctrl'
      ]}
    >
      <div className="ml-4 border-l border-border pl-4">
        <SettingsSwitchRow
          label={title}
          description={description}
          checked={settings.openLinksInAppModifierInverts === true}
          onChange={() =>
            updateSettings({
              openLinksInAppModifierInverts: settings.openLinksInAppModifierInverts !== true
            })
          }
        />
      </div>
    </SearchableSetting>
  )
}
