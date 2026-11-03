import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'

export function getChatLaunchEntriesByKey() {
  return {
    default: {
      targetSectionId: 'chat-launch-default',
      title: translate('settings.chat.launch.toggle', 'Use Chat UI by default'),
      keywords: ['chat', 'CLI', 'terminal', 'default', 'on', 'off']
    },
    agents: {
      targetSectionId: 'chat-agent-launch',
      title: translate('settings.chat.launch.agents', 'Default launch mode per agent'),
      description: translate(
        'settings.chat.launch.agentsDescription',
        'Choose whether each agent opens in Chat UI or its CLI.'
      ),
      keywords: ['chat', 'CLI', 'terminal', 'agent', 'provider', 'default']
    }
  } satisfies Record<string, SettingsSearchEntry>
}

export function getChatLaunchSearchEntries(): SettingsSearchEntry[] {
  return Object.values(getChatLaunchEntriesByKey())
}
