import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAppBackgroundSectionTitle = (): string =>
  translate('settings.appearance.background.title', 'Background')

export const getAppBackgroundSectionDescription = (): string =>
  translate(
    'settings.appearance.background.description',
    'Show an image behind Orca and make panels translucent.'
  )

const getAppBackgroundEntryCatalog = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: getAppBackgroundSectionTitle(),
    description: getAppBackgroundSectionDescription(),
    keywords: [
      ...translateSearchKeyword('settings.appearance.background.keyword.wallpaper', 'wallpaper'),
      ...translateSearchKeyword('settings.appearance.background.keyword.image', 'image'),
      ...translateSearchKeyword('settings.appearance.background.keyword.picture', 'picture'),
      ...translateSearchKeyword('settings.appearance.background.keyword.photo', 'photo'),
      ...translateSearchKeyword('settings.appearance.background.keyword.blur', 'blur'),
      ...translateSearchKeyword('settings.appearance.background.keyword.opacity', 'opacity'),
      ...translateSearchKeyword(
        'settings.appearance.background.keyword.transparency',
        'transparency'
      ),
      ...translateSearchKeyword('settings.appearance.background.keyword.translucent', 'translucent')
    ]
  }
])

/** Desktop-only: the web client has no background image IPC. */
export function getAppBackgroundEntries(
  options: { showAppBackground?: boolean } = {}
): SettingsSearchEntry[] {
  return options.showAppBackground ? getAppBackgroundEntryCatalog() : []
}
