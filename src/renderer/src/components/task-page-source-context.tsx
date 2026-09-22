import type { GitLabTaskFilter, GitLabIssueFilter } from '@/components/task-page-localized-options'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitLabProjectRef, GitLabWorkItem } from '../../../shared/gitlab-types'
import type { JiraIssue } from '../../../shared/jira-types'
import type { Repo } from '../../../shared/repo-types'
import { getLinkedWorkItemWorkspaceName, getLinkedWorkItemSuggestedName } from '@/lib/new-workspace'
import {
  type TaskSourceContext,
  normalizeTaskSourceContext,
  getTaskSourceCacheScope
} from '../../../shared/task-source-context'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import type { TaskSourceHostAvailability } from './task-source-context-summary'
import { TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { cn } from '@/lib/utils'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
export function isGitLabMRFilter(
  value: GitLabTaskFilter | GitLabIssueFilter
): value is GitLabTaskFilter {
  return value === 'opened' || value === 'merged' || value === 'closed' || value === 'all'
}
export function isGitLabIssueFilter(
  value: GitLabTaskFilter | GitLabIssueFilter
): value is GitLabIssueFilter {
  return value === 'opened' || value === 'assigned-to-me'
}
export const TASK_SEARCH_DEBOUNCE_MS = 300
export const LINEAR_ITEM_LIMIT = 36
export const JIRA_ITEM_LIMIT = 50
export const PR_CHECKS_EAGER_PREFETCH_LIMIT = 20
export const GITHUB_TASK_GRID_CLASS =
  'min-w-[790px] grid-cols-[72px_minmax(320px,1fr)_84px_100px_92px_122px]'
export const GITHUB_PR_TASK_GRID_CLASS =
  'min-w-[1020px] grid-cols-[72px_minmax(360px,2fr)_132px_128px_132px_92px_158px]'
// Why: sticky cells need the row's opaque, animated surface to prevent bleed and hover flashes.
export const GITHUB_TASK_ROW_SURFACE_CLASS = 'bg-background transition-colors'
export const GITHUB_TASK_ROW_HOVER_SURFACE_CLASS = 'group-hover/github-task-row:bg-accent'
export const GITHUB_TASK_HEADER_SURFACE_CLASS =
  '[background:color-mix(in_srgb,var(--muted)_25%,var(--background))]'
export function getGitHubWorkItemWorkspaceSeed(item: GitHubWorkItem): string {
  return getLinkedWorkItemWorkspaceName(item)?.seedName ?? getLinkedWorkItemSuggestedName(item)
}
export function getGitLabWorkItemWorkspaceSeed(item: GitLabWorkItem): string {
  return (
    getLinkedWorkItemWorkspaceName({
      type: item.type,
      provider: 'gitlab',
      number: item.number,
      title: item.title
    })?.seedName ?? getLinkedWorkItemSuggestedName(item)
  )
}
export function getJiraIssueWorkspaceSeed(issue: JiraIssue): string {
  return (
    getLinkedWorkItemWorkspaceName({
      type: 'issue',
      provider: 'jira',
      number: 0,
      title: `${issue.key} ${issue.title}`,
      jiraIdentifier: issue.key
    })?.seedName ?? getLinkedWorkItemSuggestedName(issue)
  )
}
export function getTaskPageRepoSourceContext(
  repo: Repo | null | undefined,
  provider: 'github' | 'gitlab',
  gitlabProjectRef?: GitLabProjectRef | null
): TaskSourceContext | null {
  if (!repo) {
    return null
  }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const project = projection.projects[0]
  const setup = projection.setups[0]
  const providerIdentity =
    provider === 'github' && project?.providerIdentity?.provider === 'github'
      ? project.providerIdentity
      : provider === 'gitlab' && gitlabProjectRef
        ? buildGitLabProviderIdentity(gitlabProjectRef)
        : null
  return normalizeTaskSourceContext({
    provider,
    projectId: setup?.projectId ?? project?.id ?? repo.id,
    hostId: setup?.hostId ?? getRepoExecutionHostId(repo),
    projectHostSetupId: setup?.id,
    repoId: repo.id,
    providerIdentity
  })
}
export function buildGitLabProviderIdentity(projectRef: GitLabProjectRef) {
  const pathParts = projectRef.path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  const projectName = pathParts.at(-1) ?? null
  const namespace = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : null
  return {
    provider: 'gitlab' as const,
    projectId: projectRef.path,
    namespace,
    project: projectName,
    webUrl: `https://${projectRef.host}/${projectRef.path}`
  }
}
export function getTaskSourceHostAvailabilityForHost(
  host: ExecutionHostRegistryEntry | null | undefined,
  hostId: TaskSourceContext['hostId']
): TaskSourceHostAvailability | null {
  if (!host) {
    return null
  }
  if (host.kind === 'runtime') {
    if (!host.capabilities) {
      return {
        hostId,
        reason: 'checking-task-source-capability'
      }
    }
    if (!host.capabilities.includes(TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY)) {
      return {
        hostId,
        reason: 'missing-task-source-capability'
      }
    }
  }
  if (host.health === 'local' || host.health === 'available') {
    return null
  }
  return {
    hostId,
    health: host.health,
    status: host.connectionStatus
  }
}
export function getTaskPageRepoCacheInput(repo: Repo): {
  id: string
  path: string
  executionHostId?: string | null
  sourceCacheScope?: string | null
} {
  const sourceContext = getTaskPageRepoSourceContext(repo, 'github')
  return {
    id: repo.id,
    path: repo.path,
    executionHostId: repo.executionHostId,
    sourceCacheScope:
      sourceContext?.provider === 'github' ? getTaskSourceCacheScope(sourceContext) : null
  }
}

// Why: opaque sticky headers and a padding-gap cover prevent vertical and horizontal bleed.
export const GITHUB_TASK_STICKY_ID_HEADER_CLASS = cn(
  // Why: full-height flex keeps the sticky fill from shrinking around its label.
  'sticky left-3 z-30 flex items-center before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
  GITHUB_TASK_HEADER_SURFACE_CLASS
)
export const GITHUB_TASK_STICKY_TITLE_HEADER_CLASS = cn(
  'sticky left-[92px] z-30 flex items-center border-r border-border/40 before:absolute before:-left-2 before:top-0 before:bottom-0 before:w-2 before:bg-inherit',
  GITHUB_TASK_HEADER_SURFACE_CLASS
)
export const GITHUB_TASK_STICKY_ID_CELL_CLASS = cn(
  'sticky left-3 z-20 flex items-center before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
  GITHUB_TASK_ROW_SURFACE_CLASS,
  GITHUB_TASK_ROW_HOVER_SURFACE_CLASS
)
export const GITHUB_TASK_STICKY_TITLE_CELL_CLASS = cn(
  'sticky left-[92px] z-20 flex min-w-0 flex-col justify-center border-r border-border/40 pr-2 before:absolute before:-left-2 before:top-0 before:bottom-0 before:w-2 before:bg-inherit',
  GITHUB_TASK_ROW_SURFACE_CLASS,
  GITHUB_TASK_ROW_HOVER_SURFACE_CLASS
)
export function formatRelativeTime(input: string): string {
  return formatUiRelativeTimeFromDate(input)
}
