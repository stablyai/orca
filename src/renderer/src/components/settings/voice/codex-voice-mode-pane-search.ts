import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getCodexVoiceModeSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('components.settings.voice.codexVoiceMode.title', 'Codex Voice mode'),
  description: translate(
    'auto.components.settings.voice.pane.search.codexVoiceModeDescription',
    'Choose the voice Codex speaks with in Voice mode.'
  ),
  keywords: [
    ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
    ...translateSearchKeyword(
      'auto.components.settings.voice.pane.search.codexVoiceModeKeyword',
      'codex'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.voice.pane.search.codexVoiceModeTalkKeyword',
      'talk'
    ),
    ...translateSearchKeyword('auto.components.settings.voice.pane.search.04c25a6fb0', 'openai')
  ]
}))
