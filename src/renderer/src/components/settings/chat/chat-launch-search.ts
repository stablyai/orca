import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const CHAT_LAUNCH_DEFAULT_SECTION_ID = 'chat-launch-default'

export function getChatLaunchEntriesByKey(t: Translate = translate) {
  return {
    default: {
      targetSectionId: CHAT_LAUNCH_DEFAULT_SECTION_ID,
      title: t('settings.chat.launch.toggle', 'Use Chat UI by default'),
      keywords: [
        ...translateSearchKeyword('settings.appearance.chat.title', 'Chat UI', undefined, t),
        ...translateSearchKeyword('settings.chat.providers.searchCli', 'CLI', undefined, t),
        ...translateSearchKeyword(
          'settings.chat.providers.searchTerminal',
          'terminal',
          undefined,
          t
        )
      ]
    },
    agents: {
      targetSectionId: 'chat-agent-launch',
      title: t('settings.chat.launch.agents', 'Default launch mode per agent'),
      description: t(
        'settings.chat.launch.agentsDescription',
        'Choose whether each agent opens in Chat UI or its CLI.'
      ),
      keywords: [
        ...translateSearchKeyword('settings.appearance.chat.title', 'Chat UI', undefined, t),
        ...translateSearchKeyword('settings.chat.providers.searchCli', 'CLI', undefined, t),
        ...translateSearchKeyword(
          'settings.chat.providers.searchTerminal',
          'terminal',
          undefined,
          t
        ),
        ...translateSearchKeyword('settings.chat.providers.searchAgents', 'agents', undefined, t)
      ]
    }
  } satisfies Record<string, SettingsSearchEntry>
}

export function getChatLaunchSearchEntries(t?: Translate): SettingsSearchEntry[] {
  return Object.values(getChatLaunchEntriesByKey(t))
}
