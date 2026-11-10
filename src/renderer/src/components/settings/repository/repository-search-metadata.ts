import type { Repo } from '../../../../../shared/repo-types'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getRepositoryGitWorktreeSearchMetadata } from './worktrees/repository-git-worktree-search-entries'
import { getRepositorySearchParts, type RepositoryPaneSearchOptions } from './repository-search'

export function getRepositoryPaneSearchMetadata(
  repo: Repo,
  options: RepositoryPaneSearchOptions = {},
  t: Translate = translate
) {
  const parts = getRepositorySearchParts(repo, options, t)
  const worktrees = isFolderRepo(repo) ? undefined : getRepositoryGitWorktreeSearchMetadata(repo, t)
  const identity = [
    ...(parts.projectGrouping ? [parts.projectGrouping] : []),
    parts.agentTrust,
    parts.jira,
    parts.displayName,
    parts.icon
  ]
  if (parts.github) {
    identity.push(parts.github)
  }
  if (parts.fork) {
    identity.push(parts.fork)
  }
  if (parts.projectRuntime) {
    identity.push(parts.projectRuntime)
  }
  if (worktrees) {
    identity.push(...worktrees.identity)
  }
  identity.push(parts.removeProject)
  return {
    identity,
    projectRuntime: parts.projectRuntime ? [parts.projectRuntime] : [],
    sparsePresets: worktrees?.sparsePresets ?? [],
    sharedPaths: worktrees?.sharedPaths ?? [],
    sourceControlAi: parts.sourceControlAi ?? [],
    mcp: parts.mcp ?? [],
    hooks: parts.hooks ?? [],
    // Host setups has no indexed descriptor; keep its existing empty-query admission.
    hostSetups: [] satisfies SettingsSearchEntry[]
  }
}
