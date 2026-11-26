import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import {
  getLinkRoutingModifierDescription,
  getLinkRoutingModifierTitle,
  linkRoutingSubRowClass
} from './browser-link-routing-copy'
import { useTranslate } from '../../../../i18n/use-translate'
import { usesHttpLinkMode } from '@/lib/links/preferences/http-link-mode'

type BrowserLinkRoutingModifierSettingProps = {
  settings: Pick<GlobalSettings, 'openLinksInApp' | 'openLinksInAppModifierInverts'>
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserLinkRoutingModifierSetting({
  settings,
  isMac,
  updateSettings
}: BrowserLinkRoutingModifierSettingProps): React.JSX.Element {
  const t = useTranslate()
  const openLinksInApp = settings.openLinksInApp === true
  const title = getLinkRoutingModifierTitle(openLinksInApp, t)
  const description = getLinkRoutingModifierDescription({ openLinksInApp, isMac }, t)

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
      <div className={linkRoutingSubRowClass(usesHttpLinkMode())}>
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
