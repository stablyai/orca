import type { SettingsSearchEntry } from './settings-search'

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
  {
    title: 'Speech Model',
    description: 'Select which speech-to-text model to use for dictation.',
    keywords: ['voice', 'model', 'speech', 'stt', 'download']
  }
]
