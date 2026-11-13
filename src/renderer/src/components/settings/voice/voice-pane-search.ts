import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { getCodexVoiceModeSearchEntry } from './codex-voice-mode-pane-search'

export const VOICE_SETTING_ANCHORS = {
  mode: 'voice-dictation-mode',
  language: 'voice-dictation-language',
  speechModel: 'voice-speech-model'
} as const

// The OpenAI key row shows only on the Cloud tab once a key is saved, so the result lands on the model card.
export const getOpenaiTranscriptionSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    targetSectionId: VOICE_SETTING_ANCHORS.speechModel,
    title: translate(
      'auto.components.settings.voice.pane.search.ffaa3efe7c',
      'OpenAI transcription'
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
    title: translate('auto.components.settings.voice.pane.search.dictationTitle', 'Dictation'),
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
    title: translate('auto.components.settings.voice.pane.search.shortcutTitle', 'Shortcut'),
    description: translate(
      'auto.components.settings.voice.pane.search.shortcutDescription',
      'The key that starts dictation.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.shortcutKeyword',
        'keyboard'
      )
    ]
  },
  {
    targetSectionId: VOICE_SETTING_ANCHORS.mode,
    title: translate('auto.components.settings.voice.pane.search.d0c230c061', 'Dictation mode'),
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
  {
    title: translate('auto.components.settings.voice.pane.search.microphoneTitle', 'Microphone'),
    description: translate(
      'auto.components.settings.voice.pane.search.microphoneDescription',
      'Choose which input device voice dictation uses.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.e360027a65',
        'microphone'
      ),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.micInput', 'input'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.micDevice', 'device'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.micAirpods', 'airpods'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.micDefault',
        'system default'
      )
    ]
  },
  {
    targetSectionId: VOICE_SETTING_ANCHORS.language,
    title: translate('auto.components.settings.voice.pane.search.9d83747eae', 'Dictation language'),
    description: translate(
      'auto.components.settings.voice.pane.search.dictationLanguageDescription',
      'Tell the speech model which language you speak.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.dictationLanguageKeyword',
        'language'
      ),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.10d45a9fce', 'stt')
    ]
  },
  {
    title: translate('auto.components.settings.voice.pane.search.vocabularyTitle', 'Vocabulary'),
    description: translate(
      'auto.components.settings.voice.pane.search.vocabularyDescription',
      'Names and code terms dictation spells your way, for you or for one repo.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.vocabularyKeyword',
        'dictionary'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.voice.pane.search.c7a7eaa0da',
      'Remove filler words'
    ),
    description: translate(
      'auto.components.settings.voice.pane.search.fillerWordsDescription',
      'Drop “um”, “uh” and similar sounds from dictated text.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.fillerWordsKeyword',
        'filler words'
      )
    ]
  },
  {
    title: translate('components.settings.voice.cleanup.label', 'AI cleanup'),
    description: translate(
      'auto.components.settings.voice.pane.search.cleanupDescription',
      'Fix punctuation, numbers and spoken corrections with your agent before text lands.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.cleanupKeyword',
        'correction word'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.cleanupScratchKeyword',
        'scratch that'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.voice.pane.search.silenceStopTitle',
      'Stop after silence'
    ),
    description: translate(
      'auto.components.settings.voice.pane.search.silenceStopDescription',
      'Choose how long dictation keeps listening when you stop talking.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.silenceStopKeyword',
        'silence'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.voice.pane.search.keepLoadedTitle',
      'Keep model loaded'
    ),
    description: translate(
      'auto.components.settings.voice.pane.search.modelUnloadDescription',
      'Choose when the on-device speech model is unloaded from memory.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.080202facb', 'model'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.modelUnloadKeyword',
        'unload'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.modelMemoryKeyword',
        'memory'
      )
    ]
  },
  {
    title: translate('auto.components.settings.VoicePane.speechGpuLabel', 'Use GPU'),
    description: translate(
      'components.settings.voice.gpu.description',
      'Turn off if dictation freezes your computer.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.voice.pane.search.7640ed9848', 'voice'),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.089d31a45b',
        'dictation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.voice.pane.search.gpuKeyword',
        'graphics card'
      )
    ]
  },
  getCodexVoiceModeSearchEntry(),
  getOpenaiTranscriptionSearchEntry(),
  {
    title: translate('auto.components.settings.voice.pane.search.7f5a2416a6', 'Speech model'),
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
