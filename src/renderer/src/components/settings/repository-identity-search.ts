import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { normalizeSettingsSearchQuery, type SettingsSearchEntry } from './settings-search'

export function matchesRepositoryIdentitySearch(query: string, repo: Repo): boolean {
  const normalizedQuery = normalizeSettingsSearchQuery(query)
  if (!normalizedQuery) {
    return false
  }
  return [repo.displayName, repo.path].some((value) =>
    value.toLowerCase().includes(normalizedQuery)
  )
}

export function getRepositoryIdentitySearchEntries(
  allEntries: SettingsSearchEntry[]
): SettingsSearchEntry[] {
  // Why: the language servers section renders inside the identity block.
  const titles = new Set([
    translate(
      'auto.components.settings.RepositoryLanguageServersSection.title',
      'Language Servers'
    ),
    translate('auto.components.settings.repository.search.7e1e456a95', 'Display Name'),
    translate('auto.components.settings.repository.search.b24f00294a', 'Project Icon'),
    translate('auto.components.settings.repository.search.githubAccount', 'GitHub Account'),
    translate(
      'auto.components.settings.repository.search.keepForkUpToDate',
      'Keep Fork Up to Date'
    ),
    translate('auto.components.settings.repository.search.094adbe930', 'Default Worktree Base'),
    translate('auto.components.settings.repository.search.443d127b5a', 'Worktree Location'),
    translate('auto.components.settings.repository.search.externalWorktrees', 'External worktrees'),
    translate('auto.components.settings.repository.search.projectRuntime', 'Project Runtime'),
    translate('auto.components.settings.repository.search.c5266c2c9d', 'Remove Project')
  ])
  return allEntries.filter((entry) => titles.has(entry.title))
}
