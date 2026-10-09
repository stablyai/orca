import type { Repo } from '../../../../shared/repo-types'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { getRepoTerminalThemeAvailability } from '@/lib/repo-terminal-theme-availability'

export function getRepositoryTerminalThemeSearchEntries(repo: Repo): SettingsSearchEntry[] {
  if (getRepoTerminalThemeAvailability(repo) !== 'available') {
    return []
  }
  return [
    {
      title: translate(
        'auto.components.settings.repository.search.terminalTheme',
        'Terminal Theme'
      ),
      description: translate(
        'auto.components.settings.repository.search.terminalThemeDescription',
        'Project-specific terminal color themes for dark and light mode.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.terminal',
          'terminal'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.theme', 'theme'),
        ...translateSearchKeyword('auto.components.settings.repository.search.8d045419b1', 'color'),
        ...translateSearchKeyword('auto.components.settings.repository.search.dark', 'dark'),
        ...translateSearchKeyword('auto.components.settings.repository.search.light', 'light'),
        ...translateSearchKeyword('auto.components.settings.repository.search.ghostty', 'ghostty'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.colorScheme',
          'color scheme'
        )
      ]
    }
  ]
}
