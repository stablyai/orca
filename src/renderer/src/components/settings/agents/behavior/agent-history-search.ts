import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'

export const getAgentHistorySearchEntry = createLocalizedCatalog(() => ({
  title: translate(
    'components.settings.workspaceCleanup.agentHistory.title',
    'Delete agent history with the workspace'
  ),
  description: translate(
    'components.settings.workspaceCleanup.agentHistory.description',
    'When you delete a workspace, also delete its agent chat logs (Claude Code, Codex, OpenCode and the rest) and its Orca chats. History from other workspaces is kept.'
  ),
  keywords: [
    ...translateSearchKeyword(
      'components.settings.workspaceCleanup.search.agentHistory',
      'agent history'
    ),
    ...translateSearchKeyword('components.settings.workspaceCleanup.search.chatLogs', 'chat logs'),
    ...translateSearchKeyword('components.settings.workspaceCleanup.search.diskSpace', 'disk space')
  ]
}))
