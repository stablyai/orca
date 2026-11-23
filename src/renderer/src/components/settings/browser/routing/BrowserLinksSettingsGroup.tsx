import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { BrowserLinkRoutingSetting } from './BrowserLinkRoutingSetting'
import { BrowserLinkRoutingModifierSetting } from './BrowserLinkRoutingModifierSetting'
import { BrowserLinkRoutingBackgroundSetting } from './BrowserLinkRoutingBackgroundSetting'

type BrowserLinksSettingsGroupProps = {
  settings: GlobalSettings
  linkRoutingDescription: string
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** Search filtering per row; omitted rows show. */
  show?: { openLinks?: boolean; modifier?: boolean; background?: boolean }
}

/** One app-wide home for how links open, so it no longer reads as a terminal or browser-page detail. */
export function BrowserLinksSettingsGroup({
  settings,
  linkRoutingDescription,
  isMac,
  updateSettings,
  show
}: BrowserLinksSettingsGroupProps): React.JSX.Element | null {
  const t = useTranslate()
  const { openLinks = true, modifier = true, background = true } = show ?? {}
  if (!openLinks && !modifier && !background) {
    return null
  }
  return (
    <SettingsGroup
      title={t('settings.browser.links.heading', 'Links')}
      description={t(
        'settings.browser.links.headingDescription',
        'Where web links open when you click them in Orca.'
      )}
    >
      {openLinks ? (
        <BrowserLinkRoutingSetting
          settings={settings}
          linkRoutingDescription={linkRoutingDescription}
          isMac={isMac}
          updateSettings={updateSettings}
        />
      ) : null}
      {modifier ? (
        <BrowserLinkRoutingModifierSetting
          settings={settings}
          isMac={isMac}
          updateSettings={updateSettings}
        />
      ) : null}
      {background ? (
        <BrowserLinkRoutingBackgroundSetting settings={settings} updateSettings={updateSettings} />
      ) : null}
    </SettingsGroup>
  )
}
