import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'
import type { SettingsSearchEntry } from './settings-search'

export const getFileIconEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.fileIcons.title', 'File Icons'),
    description: translate(
      'settings.appearance.fileIcons.description',
      'Choose monochrome or colored file-type icons.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.appearance.fileIcons.monochrome', 'Monochrome'),
      ...translateSearchKeyword('settings.appearance.fileIcons.colored', 'Colored'),
      ...translateSearchKeyword('settings.appearance.fileIcons.fileType', 'file type'),
      ...translateSearchKeyword('settings.appearance.fileIcons.explorer', 'file explorer'),
      ...translateSearchKeyword('settings.appearance.fileIcons.pdf', 'PDF'),
      ...translateSearchKeyword('settings.appearance.fileIcons.word', 'Word'),
      ...translateSearchKeyword('settings.appearance.fileIcons.markdown', 'Markdown'),
      ...translateSearchKeyword('settings.appearance.fileIcons.jupyter', 'Jupyter'),
      ...translateSearchKeyword('settings.appearance.fileIcons.excel', 'Excel'),
      ...translateSearchKeyword('settings.appearance.fileIcons.csv', 'CSV')
    ]
  }
])
