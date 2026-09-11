import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getQuickNotesPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.quick.notes.search.title', 'Quick Notes'),
    description: translate(
      'auto.components.settings.quick.notes.search.description',
      'Reusable plain-text snippets; picking one from the tab bar copies it to the clipboard.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.quick.notes.search.kwQuick', 'quick'),
      ...translateSearchKeyword('auto.components.settings.quick.notes.search.kwNote', 'note'),
      ...translateSearchKeyword('auto.components.settings.quick.notes.search.kwNotes', 'notes'),
      ...translateSearchKeyword('auto.components.settings.quick.notes.search.kwSnippet', 'snippet'),
      ...translateSearchKeyword(
        'auto.components.settings.quick.notes.search.kwClipboard',
        'clipboard'
      ),
      ...translateSearchKeyword('auto.components.settings.quick.notes.search.kwCopy', 'copy'),
      ...translateSearchKeyword('auto.components.settings.quick.notes.search.kwText', 'text'),
      ...translateSearchKeyword('auto.components.settings.quick.notes.search.kwPaste', 'paste')
    ]
  }
])
