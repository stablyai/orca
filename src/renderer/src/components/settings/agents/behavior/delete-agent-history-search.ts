import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'

export const getDeleteAgentHistorySearchEntry = createLocalizedCatalog(() => ({
  title: translate(
    'components.settings.agents.deleteHistoryWithWorkspace.title',
    'Delete agent history when a workspace is deleted'
  ),
  description: translate(
    'components.settings.agents.deleteHistoryWithWorkspace.description',
    "Orca, Claude Code and Codex chats from deleted workspaces are removed automatically to free disk space. They can't be recovered."
  ),
  keywords: [
    ...translateSearchKeyword('components.settings.agents.deleteHistoryWithWorkspace.chat', 'chat'),
    ...translateSearchKeyword(
      'components.settings.agents.deleteHistoryWithWorkspace.chatHistory',
      'delete chat history'
    ),
    ...translateSearchKeyword(
      'components.settings.agents.deleteHistoryWithWorkspace.transcripts',
      'transcripts'
    ),
    ...translateSearchKeyword(
      'components.settings.agents.deleteHistoryWithWorkspace.diskSpace',
      'disk space'
    ),
    ...translateSearchKeyword(
      'components.settings.agents.deleteHistoryWithWorkspace.cleanup',
      'cleanup'
    )
  ]
}))
