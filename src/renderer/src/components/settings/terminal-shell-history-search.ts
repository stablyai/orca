import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export const getTerminalShellHistorySearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.terminal.history.scopeTitle',
      'Scope shell history to each workspace'
    ),
    description: translate(
      'auto.components.settings.terminal.history.scopeDescription',
      'Keep Arrow Up, reverse search, and shell autosuggestions isolated between workspaces. Changes apply to new terminal sessions.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.terminal.history.search.shell', 'shell'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.history.search.history',
        'history'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.history.search.workspace',
        'workspace'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.history.search.worktree',
        'worktree'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.history.search.reverseSearch',
        'reverse search'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.history.search.autosuggestions',
        'autosuggestions'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.history.search.shared',
        'shared'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.history.search.isolated',
        'isolated'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.history.search.arrowUp',
        'Arrow Up'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.history.search.ctrlR', 'Ctrl+R'),
      ...translateSearchKeyword(
        'auto.components.settings.terminal.history.search.histfile',
        'HISTFILE'
      ),
      ...translateSearchKeyword('auto.components.settings.terminal.history.search.zsh', 'zsh'),
      ...translateSearchKeyword('auto.components.settings.terminal.history.search.bash', 'bash'),
      ...translateSearchKeyword('auto.components.settings.terminal.history.search.fish', 'fish')
    ]
  })
)
