import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'

export const getWorkspaceIconSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('settings.git.workspaceIcons.title', 'AI workspace icons'),
  description: translate(
    'settings.git.workspaceIcons.description',
    'Agent, model, and prompt for the AI-generated card icon. Orca draws up to 16 icons per agent call and keeps each one by workspace name.'
  ),
  keywords: [
    translate('settings.git.workspaceIcons.searchIcon', 'icon'),
    translate('settings.git.workspaceIcons.searchCard', 'workspace card'),
    translate('settings.git.workspaceIcons.searchModel', 'model'),
    translate('settings.git.workspaceIcons.searchTemplate', 'command template'),
    translate('settings.git.workspaceIcons.searchRegenerate', 'regenerate')
  ]
}))
