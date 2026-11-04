import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getChatLaunchEntriesByKey() {
  return {
    default: {
      targetSectionId: 'chat-launch-default',
      title: translate('settings.chat.launch.toggle', 'Use Chat UI by default'),
      keywords: [
        ...translateSearchKeyword('settings.appearance.chat.title', 'Chat UI'),
        ...translateSearchKeyword('settings.chat.providers.searchCli', 'CLI'),
        ...translateSearchKeyword('settings.chat.providers.searchTerminal', 'terminal')
      ]
    },
    agents: {
      targetSectionId: 'chat-agent-launch',
      title: translate('settings.chat.launch.agents', 'Default launch mode per agent'),
      description: translate(
        'settings.chat.launch.agentsDescription',
        'Choose whether each agent opens in Chat UI or its CLI.'
      ),
      keywords: [
        ...translateSearchKeyword('settings.appearance.chat.title', 'Chat UI'),
        ...translateSearchKeyword('settings.chat.providers.searchCli', 'CLI'),
        ...translateSearchKeyword('settings.chat.providers.searchTerminal', 'terminal'),
        ...translateSearchKeyword('settings.chat.providers.searchAgents', 'agents')
      ]
    }
  } satisfies Record<string, SettingsSearchEntry>
}

export function getChatLaunchSearchEntries(): SettingsSearchEntry[] {
  return Object.values(getChatLaunchEntriesByKey())
}
