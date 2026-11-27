import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getTimeFormatEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.timeFormat.title', 'Time format'),
    description: translate(
      'settings.appearance.timeFormat.description',
      'Show times on a 24-hour or 12-hour clock.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.appearance.timeFormat.keyword.time', 'time'),
      ...translateSearchKeyword('settings.appearance.timeFormat.keyword.clock', 'clock'),
      ...translateSearchKeyword('settings.appearance.timeFormat.keyword.timestamp', 'timestamp'),
      ...translateSearchKeyword('settings.appearance.timeFormat.24h', '24-hour'),
      ...translateSearchKeyword('settings.appearance.timeFormat.12h', '12-hour'),
      ...translateSearchKeyword('settings.appearance.timeFormat.keyword.amPm', 'AM/PM', {
        aliases: ['am', 'pm']
      })
    ]
  }
])
