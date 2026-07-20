import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalBehaviorSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.search.autosuggest_title',
      'Command Autosuggest'
    ),
    description: translate(
      'auto.components.settings.terminal.search.autosuggest_description',
      'Show an inline ghost-text suggestion from prior commands while typing at a shell prompt.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autosuggest_kw_autosuggest',
        'autosuggest'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autosuggest_kw_autocomplete',
        'autocomplete'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autosuggest_kw_suggestion',
        'suggestion'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autosuggest_kw_history',
        'history'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.search.autosuggest_kw_ghost_text',
        'ghost text'
      )
    ]
  }
])
