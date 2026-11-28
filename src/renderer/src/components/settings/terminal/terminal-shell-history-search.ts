import type { SettingsSearchEntry } from '../search/settings-search'
import { searchKeywordTranslator } from '../search/settings-search-keywords'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getTerminalShellHistorySearchEntry(t: Translate = translate): SettingsSearchEntry {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return {
    title: t(
      'auto.components.settings.terminal.history.scopeTitle',
      'Scope bash, zsh, and fish history by workspace'
    ),
    description: t(
      'auto.components.settings.terminal.history.scopeDescription',
      'Keeps command history separate between workspaces for bash, zsh, and fish. PowerShell and Command Prompt are unaffected. Changes apply to new terminal sessions.'
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
  }
}
