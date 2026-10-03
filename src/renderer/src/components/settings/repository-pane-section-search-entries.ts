import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { getRepositoryPaneSearchEntries } from './repository-search'
import type { SettingsSearchEntry } from './settings-search'
import { getRepositoryTerminalThemeSearchEntries } from './repository-terminal-theme-search-entries'

type RepositoryPaneSectionSearchEntries = {
  identityEntries: SettingsSearchEntry[]
  sparsePresetEntries: SettingsSearchEntry[]
  hooksEntries: SettingsSearchEntry[]
  mcpEntries: SettingsSearchEntry[]
  symlinkEntries: SettingsSearchEntry[]
  sourceControlAiEntries: SettingsSearchEntry[]
  terminalThemeEntries: SettingsSearchEntry[]
  hostSetupEntries: SettingsSearchEntry[]
  projectRuntimeEntries: SettingsSearchEntry[]
}

/** Splits the repository pane's search catalog into the entry set each section filters on. */
export function getRepositoryPaneSectionSearchEntries(
  repo: Repo,
  options: { isLocalWindowsProject: boolean }
): RepositoryPaneSectionSearchEntries {
  const allEntries = getRepositoryPaneSearchEntries(repo, {
    isLocalWindowsProject: options.isLocalWindowsProject
  })
  const identityEntryTitles = new Set([
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
  const identityEntries = allEntries.filter((entry) => identityEntryTitles.has(entry.title))
  const sparsePresetEntries = allEntries.filter((entry) =>
    ['Sparse Checkout Presets'].includes(entry.title)
  )
  const hooksEntries = allEntries.filter((entry) =>
    [
      'Setup Script',
      'Archive Script',
      'Advanced',
      'When to Run Setup',
      'Custom GitHub Issue Command'
    ].includes(entry.title)
  )
  const mcpEntries = allEntries.filter((entry) => entry.title === 'MCP Configs')
  const symlinkEntries = allEntries.filter((entry) => entry.title === 'Worktree Shared Paths')
  const sourceControlAiEntries = allEntries.filter((entry) => entry.title === 'Git AI Author')
  const terminalThemeEntries = getRepositoryTerminalThemeSearchEntries(repo)
  const hostSetupEntries = allEntries.filter((entry) => entry.title === 'Available Hosts')
  const projectRuntimeEntries = allEntries.filter((entry) => entry.title === 'Project Runtime')
  return {
    identityEntries,
    sparsePresetEntries,
    hooksEntries,
    mcpEntries,
    symlinkEntries,
    sourceControlAiEntries,
    terminalThemeEntries,
    hostSetupEntries,
    projectRuntimeEntries
  }
}
