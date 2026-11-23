import { setRendererUiLanguage } from '@/i18n/i18n'
import type { UiLanguage } from '../../../../../../shared/i18n/ui-language'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../../store'
import { BrowserLinksSettingsGroup } from './BrowserLinksSettingsGroup'
import { getBrowserLinkRoutingDescription } from './browser-link-routing-copy'

function OpenLinksFixture(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings) {
    return null
  }
  return (
    <div className="settings-view-shell bg-background p-4 text-foreground">
      {/* The whole Links group, as Settings renders it, so its heading is reviewed with the control. */}
      <BrowserLinksSettingsGroup
        settings={settings}
        linkRoutingDescription={getBrowserLinkRoutingDescription({
          isMac: true
        })}
        isMac
        updateSettings={(updates) => void updateSettings(updates)}
      />
    </div>
  )
}

const openLinks = (
  fields: Partial<GlobalSettings>,
  language?: UiLanguage
): ReturnType<typeof defineFixture> =>
  defineFixture({
    // The narrowest settings column.
    width: 340,
    store: { settings: { ...getDefaultSettings('/fixture'), ...fields } },
    render: () => <OpenLinksFixture />,
    ...(language ? { interact: () => setRendererUiLanguage(language) } : {})
  })

const ASK = { httpLinkClickBehavior: 'ask', openLinksInApp: false } as const

/** A new install: links open in the system browser without asking. */
export const systemBrowser = openLinks({
  httpLinkClickBehavior: 'open',
  openLinksInApp: false
})
export const orcaBrowser = openLinks({
  httpLinkClickBehavior: 'open',
  openLinksInApp: true
})
/** Ask shows the nested "Open directly in" row for the modifier click and the first choice. */
export const askEachTime = openLinks(ASK)
export const askEachTimeGerman = openLinks(ASK, 'de')
export const askEachTimeRussian = openLinks(ASK, 'ru')
