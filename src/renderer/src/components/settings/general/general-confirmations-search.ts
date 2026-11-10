import { translateSearchKeyword } from '../search/settings-search-keywords'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getGeneralConfirmationSearchEntries = createLocalizedCatalog(() => ({
  pinned: {
    title: translate('settings.general.confirmations.pinned', 'Closing a pinned tab'),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.confirmations', 'confirmations'),
      ...translateSearchKeyword('auto.components.settings.general.search.867dddea41', 'pinned'),
      ...translateSearchKeyword('auto.components.settings.general.search.5250cf0e48', 'pin'),
      ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
      ...translateSearchKeyword('auto.components.settings.general.search.9f8558233a', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.general.search.afa37a34e1', 'close'),
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
      ...translateSearchKeyword('components.settings.terminal.clipboard.search.chat', 'chat'),
      ...translateSearchKeyword('auto.components.settings.general.search.terminal', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.running_terminal',
        'running'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.agent', 'agent'),
      ...translateSearchKeyword('auto.components.settings.general.search.command', 'command'),
      ...translateSearchKeyword('auto.components.settings.general.search.confirm', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.general.search.close', 'close'),
      ...translateSearchKeyword('auto.components.settings.general.search.omp', 'OMP'),
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
      ...translateSearchKeyword('auto.components.settings.general.search.84c67d0108', 'delete'),
      ...translateSearchKeyword('auto.components.settings.general.search.df10666259', 'worktree'),
      ...translateSearchKeyword('auto.components.settings.general.search.7baf524b04', 'workspace'),
      ...translateSearchKeyword('auto.components.settings.general.search.9f8558233a', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.general.search.ca86dd6e27', 'dialog'),
      ...translateSearchKeyword('auto.components.settings.general.search.7e9b556873', 'skip'),
      ...translateSearchKeyword('auto.components.settings.general.search.0efc9d96ad', 'prompt'),
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
      ...translateSearchKeyword('auto.components.settings.general.search.84c67d0108', 'delete'),
      ...translateSearchKeyword('auto.components.settings.general.search.7edf4f69e2', 'automation'),
      ...translateSearchKeyword('auto.components.settings.general.search.9f8558233a', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.general.search.ca86dd6e27', 'dialog'),
      ...translateSearchKeyword('auto.components.settings.general.search.7e9b556873', 'skip'),
      ...translateSearchKeyword('auto.components.settings.general.search.0efc9d96ad', 'prompt'),
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
      ...translateSearchKeyword('auto.components.settings.general.search.84c67d0108', 'delete'),
      ...translateSearchKeyword('settings.general.search.keywords.artifact', 'artifact'),
      ...translateSearchKeyword('settings.general.search.keywords.share', 'share'),
      ...translateSearchKeyword('settings.general.search.keywords.link', 'link'),
      ...translateSearchKeyword('auto.components.settings.general.search.9f8558233a', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.general.search.ca86dd6e27', 'dialog'),
      ...translateSearchKeyword('auto.components.settings.general.search.7e9b556873', 'skip'),
      ...translateSearchKeyword('auto.components.settings.general.search.0efc9d96ad', 'prompt'),
      ...translateSearchKeyword('settings.general.search.keywords.ask_before', 'ask before'),
      translate(
        'auto.components.settings.GeneralWorkspaceSettingsSection.2ffd7c4fc8',
        'Ask before deleting artifacts'
      )
    ]
  }
}))
