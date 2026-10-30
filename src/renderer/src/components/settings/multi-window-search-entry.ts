import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getMultiWindowSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('settings.multiWindow.title', 'Multiple windows'),
    description: translate(
      'settings.multiWindow.description',
      'Open additional Orca windows with independent projects and tabs.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.multiWindow.keywords.window', 'window'),
      ...translateSearchKeyword('settings.multiWindow.keywords.monitor', 'monitor'),
      ...translateSearchKeyword('settings.multiWindow.keywords.project', 'project'),
      ...translateSearchKeyword('settings.multiWindow.keywords.experimental', 'experimental')
    ]
  }
}
