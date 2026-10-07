import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export const getChatNamingSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-names',
  title: translate('settings.chat.names.title', 'Chat names'),
  description: translate(
    'settings.chat.names.description',
    'Use an agent to name new chats from their first message. Without a generated name, chats stay Claude Chat or Codex Chat.'
  ),
  keywords: [
    translate('settings.chat.names.enable', 'Name chats automatically'),
    translate('settings.chat.names.searchAgent', 'agent'),
    translate('settings.chat.names.searchTemplate', 'command template')
  ]
}))
