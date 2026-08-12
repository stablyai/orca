import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getNativeChatExperimentalSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('auto.components.settings.experimental.search.nativeChat.title', 'Chat UI'),
    description: translate(
      'auto.components.settings.experimental.search.nativeChat.description',
      'Preview the desktop chat surface for supported agent terminal sessions.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.nativeChat.native',
        'native'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.nativeChat.chat',
        'chat'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.nativeChat.claude',
        'claude'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.nativeChat.codex',
        'codex'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.nativeChat.grok',
        'grok'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.nativeChat.terminal',
        'terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.nativeChat.agent',
        'agent'
      )
    ]
  }
}
