import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getFileOpenClickModeEntry(t: Translate = translate): SettingsSearchEntry {
  return {
    title: t('settings.fileOpenClickMode.title', 'Open files with'),
    description: t(
      'settings.fileOpenClickMode.description',
      'Choose how to open files in the file explorer. Single click is the default.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'settings.fileOpenClickMode.keywords.fileExplorer',
        'file explorer',
        undefined,
        t
      ),
      ...translateSearchKeyword('settings.fileOpenClickMode.keywords.open', 'open', undefined, t),
      ...translateSearchKeyword('settings.fileOpenClickMode.keywords.click', 'click', undefined, t),
      t('settings.fileOpenClickMode.single', 'Single click'),
      t('settings.fileOpenClickMode.double', 'Double click')
    ]
  }
}
