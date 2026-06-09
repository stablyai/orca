import type { SettingsSearchEntry } from './settings-search'

export const OPENAI_TRANSCRIPTION_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'OpenAI Transcription',
  description: 'Configure the OpenAI API key used for cloud speech-to-text models.',
  keywords: ['voice', 'speech', 'stt', 'openai', 'api key', 'cloud', 'transcription']
}

export const VOICE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Enable Voice Dictation',
    description: 'Master toggle for voice dictation features.',
    keywords: ['voice', 'dictation', 'speech', 'microphone', 'stt']
  },
  {
    title: 'Dictation Mode',
    description: 'Toggle or hold-to-talk dictation behavior.',
    keywords: ['voice', 'dictation', 'mode', 'toggle', 'hold', 'push to talk']
  },
  OPENAI_TRANSCRIPTION_SEARCH_ENTRY,
  {
    title: 'Speech Model',
    description: 'Select a local or cloud speech-to-text model to use for dictation.',
    keywords: ['voice', 'model', 'speech', 'stt', 'download', 'openai', 'api key', 'cloud']
  }
]
