import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getOpenaiTranscriptionSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.voice.pane.search.ebfd0b32e5',
      'OpenAI Transcription'
    ),
    description: translate(
      'auto.components.settings.voice.pane.search.dcc7846641',
      'Configure the OpenAI API key used for cloud speech-to-text models.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.3d8b853963', 'speech'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.10d45a9fce', 'stt'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.04c25a6fb0', 'openai'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.2d206de105', 'api key'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.f6e0dfa61c', 'cloud'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.322d457a0d',
        'transcription'
      )
    ]
  })
)

export const getVoicePaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.voice.pane.search.20574cbc72',
      'Enable Voice Dictation'
    ),
    description: translate(
      'auto.components.settings.voice.pane.search.698376a38d',
      'Master toggle for voice dictation features.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.3d8b853963', 'speech'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.e360027a65',
        'microphone'
      ),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.10d45a9fce', 'stt')
    ]
  },
  {
    title: translate('auto.components.settings.voice.pane.search.6a3abb4338', 'Dictation Mode'),
    description: translate(
      'auto.components.settings.voice.pane.search.748b33e531',
      'Toggle or hold-to-talk dictation behavior.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.d86f5600da', 'mode'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.6fa48bcd41', 'toggle'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.064a9bd94a', 'hold'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.931b1a9e53',
        'push to talk'
      )
    ]
  },
  getOpenaiTranscriptionSearchEntry(),
  {
    title: translate('auto.components.settings.voice.pane.search.7e62cd7c41', 'Speech Model'),
    description: translate(
      'auto.components.settings.voice.pane.search.56defcd6c3',
      'Select a local or cloud speech-to-text model to use for dictation.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.080202facb', 'model'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.3d8b853963', 'speech'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.10d45a9fce', 'stt'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.b9dee49cd7',
        'download'
      ),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.04c25a6fb0', 'openai'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.2d206de105', 'api key'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.f6e0dfa61c', 'cloud')
    ]
  }
])
