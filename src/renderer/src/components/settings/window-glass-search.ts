import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getWindowGlassStyleSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('settings.windowGlass.style', 'Glass Style'),
    description: translate(
      'settings.windowGlass.styleDescription',
      'Choose a quiet frosted surface or glass with subtle edge highlights. Requires Window Glass.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.windowGlass.keywords.glass', 'glass'),
      ...translateSearchKeyword('settings.windowGlass.keywords.liquid', 'liquid'),
      ...translateSearchKeyword('settings.windowGlass.keywords.frosted', 'frosted'),
      ...translateSearchKeyword('settings.windowGlass.keywords.vibrancy', 'vibrancy'),
      ...translateSearchKeyword('settings.windowGlass.keywords.acrylic', 'acrylic'),
      ...translateSearchKeyword('settings.windowGlass.keywords.material', 'material')
    ]
  }
}
