import type { Repo } from '../../../../../shared/repo-types'
import { getRepositoryPresenceSearchEntries } from './repository-project-presence-search'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../shared/execution-host'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../search/settings-search-keywords'
import { getRepositoryGitAuthorSearchEntries } from './source-control/repository-git-author-search-entries'
import { getRepositoryMcpConfigSearchEntries } from './mcp/mcp-config-search'
import { getRepositoryGitHooksSearchEntries } from './hooks/repository-git-hooks-search-entries'
import {
  getRepositoryGitWorktreeSearchEntries,
  getRepositoryGitWorktreeSearchMetadata
} from './worktrees/repository-git-worktree-search-entries'
import { getRepositoryFormatterSearchEntry } from './RepositoryFormatterSection'
import { getRepositoryAgentTrustSearchEntry } from './RepositoryAgentTrustSection'
import { getRepositoryWorkspaceCleanupSearchEntry } from './workspace-cleanup/repository-workspace-cleanup-search'
import {
  getRepositoryClaudeAccountSearchEntry,
  getRepositoryGitHubAccountSearchEntry
} from './repository-account-search-entries'

type RepositoryPaneSearchOptions = {
  isLocalWindowsProject?: boolean
  windowsRuntimeSupported?: boolean
}

function getRepositorySearchParts(
  repo: Repo,
  options: RepositoryPaneSearchOptions = {},
  t: Translate = translate
) {
  const translateSearchKeyword = searchKeywordTranslator(t)
  const isFolder = isFolderRepo(repo)
  const isLocalWindowsProject =
    options.isLocalWindowsProject ??
    (Boolean(options.windowsRuntimeSupported) &&
      getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)

  const jira = {
    title: t('components.RepositoryJiraProjectSection.title', 'Default Jira project'),
    description: t(
      'components.RepositoryJiraProjectSection.description',
      'Default the Jira issue picker and Tasks list to this project. You can change it for each worktree.'
    ),
    keywords: [
      repo.displayName,
      ...translateSearchKeyword('components.RepositoryJiraProjectSection.keywordJira', 'jira'),
      ...translateSearchKeyword(
        'components.RepositoryJiraProjectSection.keywordDefaultProject',
        'default project'
      ),
      ...translateSearchKeyword(
        'components.RepositoryJiraProjectSection.keywordIssuePicker',
        'issue picker'
      )
    ]
  }
  const displayName = {
    title: t('auto.components.settings.repository.search.7f380f89ea', 'Display name'),
    description: t(
      'auto.components.settings.repository.search.883aad2801',
      'Project-specific display details for the sidebar and tabs.'
    ),
    keywords: [
      repo.displayName,
      repo.path,
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.92af66c7ce',
        'project name'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.cd73b976d7',
        'repository name'
      )
    ]
  }
  const icon = {
    title: t('auto.components.settings.repository.search.0fe07b9e90', 'Project icon'),
    description: t(
      'auto.components.settings.repository.search.a1f3a2bd47',
      'Project icon and color used in the sidebar and tabs.'
    ),
    keywords: [
      repo.displayName,
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.6438a94c63',
        'project icon'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.b2546efab5',
        'repository icon'
      ),
      ...translateSearchKeyword('auto.components.settings.repository.search.8d045419b1', 'color'),
      ...translateSearchKeyword('auto.components.settings.repository.search.6d8de2f090', 'hex'),
      ...translateSearchKeyword('auto.components.settings.repository.search.c1075178cf', 'badge'),
      ...translateSearchKeyword('auto.components.settings.repository.search.cb4b4de666', 'avatar'),
      ...translateSearchKeyword('auto.components.settings.repository.search.9dc60d7f6d', 'github'),
      ...translateSearchKeyword('auto.components.settings.repository.search.1e73e840ff', 'emoji'),
      ...translateSearchKeyword('auto.components.settings.repository.search.27733eb6c1', 'favicon')
    ]
  }
  const fork =
    repo.upstream && !isFolder
      ? {
          title: t('auto.components.settings.repository.search.f94afd4078', 'Keep fork up to date'),
          description: t(
            'auto.components.settings.repository.search.keepForkUpToDateDescription',
            'Safely fast-forward this fork from upstream.'
          ),
          keywords: [
            repo.displayName,
            repo.upstream.owner,
            repo.upstream.repo,
            ...translateSearchKeyword('auto.components.settings.repository.search.fork', 'fork'),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.upstream',
              'upstream'
            ),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.syncFork',
              'sync fork'
            ),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.fastForward',
              'fast-forward'
            ),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.behindUpstream',
              'behind upstream'
            ),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.origin',
              'origin'
            ),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.defaultBranch',
              'default branch'
            )
          ]
        }
      : undefined
  const projectRuntime =
    isFolder || !isLocalWindowsProject
      ? undefined
      : {
          title: t('auto.components.settings.repository.search.7a89e2dc09', 'Project runtime'),
          description: t(
            'auto.components.settings.repository.search.projectRuntimeDescription',
            'Choose whether this project runs on Windows or WSL.'
          ),
          keywords: [
            repo.displayName,
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.runtime',
              'runtime'
            ),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.execution',
              'execution'
            ),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.windowsHost',
              'windows host'
            ),
            ...translateSearchKeyword('auto.components.settings.repository.search.wsl', 'wsl'),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.distro',
              'distro'
            ),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.agentRuntime',
              'agent runtime'
            ),
            ...translateSearchKeyword(
              'auto.components.settings.repository.search.skillRuntime',
              'skill runtime'
            )
          ]
        }
  const { removeProject, sidebarVisibility } = getRepositoryPresenceSearchEntries(repo, t)
  return {
    agentTrust: getRepositoryAgentTrustSearchEntry(),
    jira,
    displayName,
    icon,
    claudeAccount: getRepositoryClaudeAccountSearchEntry(repo, t),
    github: isFolder ? undefined : getRepositoryGitHubAccountSearchEntry(repo, t),
    fork,
    projectRuntime,
    sidebarVisibility,
    removeProject,
    sourceControlAi: isFolder ? undefined : getRepositoryGitAuthorSearchEntries(repo, t),
    mcp: isFolder ? undefined : getRepositoryMcpConfigSearchEntries(repo, t),
    hooks: getRepositoryGitHooksSearchEntries(repo, t)
  }
}

export function getRepositoryPaneSearchEntries(
  repo: Repo,
  options: RepositoryPaneSearchOptions = {},
  t: Translate = translate
): SettingsSearchEntry[] {
  const parts = getRepositorySearchParts(repo, options, t)
  const entries = [
    getRepositoryFormatterSearchEntry(t),
    parts.agentTrust,
    parts.jira,
    parts.displayName,
    parts.icon,
    parts.claudeAccount
  ]
  if (parts.github) {
    entries.push(parts.github)
  }
  if (parts.fork) {
    entries.push(parts.fork)
  }
  if (parts.projectRuntime) {
    entries.push(parts.projectRuntime)
  }
  if (!isFolderRepo(repo)) {
    entries.push(...getRepositoryGitWorktreeSearchEntries(repo, t))
    entries.push(getRepositoryWorkspaceCleanupSearchEntry(repo, t))
  }
  entries.push(parts.sidebarVisibility, parts.removeProject)
  if (parts.sourceControlAi) {
    entries.push(...parts.sourceControlAi)
  }
  if (parts.mcp) {
    entries.push(...parts.mcp)
  }
  if (parts.hooks) {
    entries.push(...parts.hooks)
  }
  return entries
}

export function getRepositoryPaneSearchMetadata(
  repo: Repo,
  options: RepositoryPaneSearchOptions = {},
  t: Translate = translate
) {
  const parts = getRepositorySearchParts(repo, options, t)
  const worktrees = isFolderRepo(repo) ? undefined : getRepositoryGitWorktreeSearchMetadata(repo, t)
  const identity = [
    parts.agentTrust,
    parts.jira,
    parts.displayName,
    parts.icon,
    parts.claudeAccount
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
  return {
    identity,
    removeProject: parts.removeProject,
    sidebarVisibility: parts.sidebarVisibility,
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
