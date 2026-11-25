import type { SettingsSearchEntry } from '../settings/search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../settings/search/settings-search-keywords'

export function getAppRailSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('auto.components.settings.experimental.search.appRail.title', 'App rail'),
    description: translate(
      'auto.components.settings.experimental.search.appRail.description',
      'Icon bar on the left edge for switching between workspaces and other pages.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.appRail.rail',
        'rail'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.appRail.navigation',
        'navigation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.appRail.sidebar',
        'sidebar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.appRail.icons',
        'icons'
      )
    ]
  }
}
