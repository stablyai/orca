import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import type { SettingsSearchEntry } from './settings-search'

export function getStructuredAgentStreamingExperimentalSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.ExperimentalPane.harnessStreaming.title',
      'Live agent streaming'
    ),
    description: translate(
      'auto.components.settings.ExperimentalPane.harnessStreaming.description',
      'Use structured agent transports for live responses in Chat UI and Rooms.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.experimental.streaming', 'streaming'),
      ...translateSearchKeyword('settings.experimental.machine', 'machine'),
      ...translateSearchKeyword('settings.experimental.steering', 'steering'),
      ...translateSearchKeyword('settings.experimental.rooms', 'rooms'),
      ...STRUCTURED_AGENT_NAMES.flatMap((agent) =>
        translateSearchKeyword(`settings.experimental.streaming.${agent}`, agent)
      )
    ]
  }
}

const STRUCTURED_AGENT_NAMES = ['claude', 'openclaude', 'codex', 'grok', 'omp'] as const
