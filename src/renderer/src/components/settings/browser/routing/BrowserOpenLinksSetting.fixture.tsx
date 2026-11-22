import { setRendererUiLanguage } from '@/i18n/i18n'
import type { UiLanguage } from '../../../../../../shared/i18n/ui-language'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../../store'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { BrowserOpenLinksSetting } from './BrowserOpenLinksSetting'

function OpenLinksFixture(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  if (!settings) {
    return null
  }
  return (
    <div className="settings-view-shell bg-background p-4 text-foreground">
      <SettingsGroup>
        <BrowserOpenLinksSetting settings={settings} isMac />
      </SettingsGroup>
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
export const systemBrowser = openLinks({ httpLinkClickBehavior: 'open', openLinksInApp: false })
export const orcaBrowser = openLinks({ httpLinkClickBehavior: 'open', openLinksInApp: true })
/** Ask shows the nested "Open directly in" row for the modifier click and the first choice. */
export const askEachTime = openLinks(ASK)
export const askEachTimeGerman = openLinks(ASK, 'de')
export const askEachTimeRussian = openLinks(ASK, 'ru')
