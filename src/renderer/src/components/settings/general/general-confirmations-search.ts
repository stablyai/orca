import { translateSearchKeyword } from '../search/settings-search-keywords'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getGeneralConfirmationSearchEntries = createLocalizedCatalog(() => ({
  pinned: {
    title: translate('settings.general.confirmations.pinned', 'Closing a pinned tab'),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.confirmations', 'confirmations'),
      ...translateSearchKeyword('settings.general.search.keywords.pinned', 'pinned'),
      ...translateSearchKeyword('settings.general.search.keywords.tab', 'tab'),
      ...translateSearchKeyword('settings.general.search.keywords.confirm', 'confirm'),
      ...translateSearchKeyword('settings.general.search.keywords.close', 'close'),
      ...translateSearchKeyword('settings.general.search.keywords.ask_before', 'ask before'),
      translate(
        'auto.components.settings.GeneralPane.5cb5475664',
        'Confirm before closing pinned tabs'
      )
    ]
  },
  running: {
    title: translate(
      'settings.general.confirmations.running',
      'Closing a running chat or terminal'
    ),
    description: translate(
      'settings.general.confirmations.runningHelp',
      'Ask before stopping an agent or command that’s still running.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.confirmations', 'confirmations'),
      ...translateSearchKeyword('settings.general.search.keywords.chat', 'chat'),
      ...translateSearchKeyword('settings.general.search.keywords.terminal', 'terminal'),
      ...translateSearchKeyword('settings.general.search.keywords.agent', 'agent'),
      ...translateSearchKeyword('settings.general.search.keywords.command', 'command'),
      ...translateSearchKeyword('settings.general.search.keywords.confirm', 'confirm'),
      ...translateSearchKeyword('settings.general.search.keywords.close', 'close'),
      ...translateSearchKeyword('settings.general.search.keywords.omp', 'OMP'),
      ...translateSearchKeyword('settings.general.search.keywords.ask_before', 'ask before'),
      translate(
        'auto.components.settings.GeneralPane.confirm_running_work_close',
        'Confirm before closing active chats or terminals'
      )
    ]
  },
  workspace: {
    id: 'general-skip-delete-worktree-confirm',
    title: translate('settings.general.confirmations.workspace', 'Deleting a workspace'),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.confirmations', 'confirmations'),
      ...translateSearchKeyword('settings.general.search.keywords.delete', 'delete'),
      ...translateSearchKeyword('settings.general.search.keywords.worktree', 'worktree'),
      ...translateSearchKeyword('settings.general.search.keywords.workspace', 'workspace'),
      ...translateSearchKeyword('settings.general.search.keywords.confirm', 'confirm'),
      ...translateSearchKeyword('settings.general.search.keywords.dialog', 'dialog'),
      ...translateSearchKeyword('settings.general.search.keywords.skip', 'skip'),
      ...translateSearchKeyword('settings.general.search.keywords.prompt', 'prompt'),
      ...translateSearchKeyword('settings.general.search.keywords.ask_before', 'ask before'),
      translate(
        'auto.components.settings.GeneralWorkspaceSettingsSection.c2d4beaf3a',
        'Ask before deleting workspaces'
      )
    ]
  },
  automation: {
    id: 'general-skip-delete-automation-confirm',
    title: translate('settings.general.confirmations.automation', 'Deleting an automation'),
    description: translate(
      'settings.general.confirmations.automationHelp',
      'Its run history is deleted too.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.confirmations', 'confirmations'),
      ...translateSearchKeyword('settings.general.search.keywords.delete', 'delete'),
      ...translateSearchKeyword('settings.general.search.keywords.automation', 'automation'),
      ...translateSearchKeyword('settings.general.search.keywords.confirm', 'confirm'),
      ...translateSearchKeyword('settings.general.search.keywords.dialog', 'dialog'),
      ...translateSearchKeyword('settings.general.search.keywords.skip', 'skip'),
      ...translateSearchKeyword('settings.general.search.keywords.prompt', 'prompt'),
      ...translateSearchKeyword('settings.general.search.keywords.ask_before', 'ask before'),
      translate(
        'auto.components.settings.GeneralWorkspaceSettingsSection.3ae2a59ce9',
        'Ask before deleting automations'
      )
    ]
  },
  artifact: {
    id: 'general-skip-delete-artifact-confirm',
    title: translate('settings.general.confirmations.artifact', 'Deleting an artifact'),
    description: translate(
      'settings.general.confirmations.artifactHelp',
      'Anyone with its public link loses access.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.confirmations', 'confirmations'),
      ...translateSearchKeyword('settings.general.search.keywords.delete', 'delete'),
      ...translateSearchKeyword('settings.general.search.keywords.artifact', 'artifact'),
      ...translateSearchKeyword('settings.general.search.keywords.share', 'share'),
      ...translateSearchKeyword('settings.general.search.keywords.link', 'link'),
      ...translateSearchKeyword('settings.general.search.keywords.confirm', 'confirm'),
      ...translateSearchKeyword('settings.general.search.keywords.dialog', 'dialog'),
      ...translateSearchKeyword('settings.general.search.keywords.skip', 'skip'),
      ...translateSearchKeyword('settings.general.search.keywords.prompt', 'prompt'),
      ...translateSearchKeyword('settings.general.search.keywords.ask_before', 'ask before'),
      translate(
        'auto.components.settings.GeneralWorkspaceSettingsSection.2ffd7c4fc8',
        'Ask before deleting artifacts'
      )
    ]
  }
}))
