import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'

export const getChatNamingSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-names',
  title: translate('settings.chat.names.title', 'Chat names'),
  description: translate(
    'settings.chat.names.description',
    'Use each chat’s agent to name it from its first message. Choose another naming agent in Advanced. Until a name is generated, a chat shows its first message.'
  ),
  keywords: [
    ...translateSearchKeyword('settings.chat.names.enable', 'Name chats automatically'),
    ...translateSearchKeyword('settings.chat.names.searchAgent', 'agent'),
    ...translateSearchKeyword(
      'settings.chat.names.antigravity',
      'Generate chat titles with Antigravity'
    ),
    ...translateSearchKeyword('settings.chat.names.searchTemplate', 'command template')
  ]
}))

/** The chat-name recipe row inside the Advanced disclosure, where the naming agent is chosen. */
export const CHAT_NAME_AGENT_SECTION_ID = 'chat-names-agent'
