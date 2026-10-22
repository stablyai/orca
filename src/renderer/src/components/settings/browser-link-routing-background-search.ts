import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getLinkRoutingBackgroundSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.BrowserLinkRoutingBackgroundSetting.title',
      'Open links in Orca in the background'
    ),
    description: translate(
      'auto.components.settings.BrowserLinkRoutingBackgroundSetting.description',
      "Links opened in Orca's browser load in a new tab without switching to it."
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
      ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingModifier.routing',
        'routing'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.background',
        'background'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.focus',
        'focus'
      ),
      ...translateSearchKeyword('auto.components.settings.browser.search.c4e3bf3282', 'tabs')
    ]
  })
)
