import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getGeneralConfirmationSearchEntries = createLocalizedCatalog(() => ({
  pinned: {
    title: translate('settings.general.confirmations.pinned', 'Closing a pinned tab'),
    keywords: [
      'confirmations',
      'pinned',
      'tab',
      'confirm',
      'close',
      'ask before',
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
      'confirmations',
      'chat',
      'terminal',
      'agent',
      'command',
      'confirm',
      'close',
      'OMP',
      'ask before',
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
      'confirmations',
      'delete',
      'worktree',
      'workspace',
      'confirm',
      'dialog',
      'skip',
      'prompt',
      'ask before',
      translate(
        'auto.components.settings.GeneralWorkspaceSettingsSection.9f380934cf',
        'Ask Before Deleting Workspaces'
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
      'confirmations',
      'delete',
      'automation',
      'confirm',
      'dialog',
      'skip',
      'prompt',
      'ask before',
      translate(
        'auto.components.settings.GeneralWorkspaceSettingsSection.ea98373cd8',
        'Ask Before Deleting Automations'
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
      'confirmations',
      'delete',
      'artifact',
      'share',
      'link',
      'confirm',
      'dialog',
      'skip',
      'prompt',
      'ask before',
      translate(
        'auto.components.settings.GeneralWorkspaceSettingsSection.31e300af1c',
        'Ask Before Deleting Artifacts'
      )
    ]
  }
}))
