import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getOffscreenBrowserPagesSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.offscreenBrowserPages.search.title',
      'Focus-safe browser pages'
    ),
    description: translate(
      'auto.components.settings.offscreenBrowserPages.search.description',
      'Render browser tabs offscreen so agent clicks and typing never take focus from your terminal.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.offscreenBrowserPages.search.keywordBrowser',
        'browser'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.offscreenBrowserPages.search.keywordFocus',
        'focus'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.offscreenBrowserPages.search.keywordIme',
        'ime'
      )
    ],
    targetSectionId: 'offscreen-browser-pages'
  })
)
