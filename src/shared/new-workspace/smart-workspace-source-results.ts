import type { GitHubWorkItem } from '../github/work-item-types'
import type { GitLabWorkItem } from '../gitlab-types'
import type { GiteaWorkItem } from '../gitea-types'
import type { JiraIssue } from '../jira/jira-types'
import type { LinearIssue } from '../linear/issue-types'
import type { LinearCollectionResult } from '../linear/workspace-types'
import type { BaseRefSearchResult } from '../repo-types'
import { parseJiraIssueUrl } from '../jira/jira-issue-url'
import { buildJiraTextMatchJql } from '../jira/jira-search-input-jql'
import type { GitHubIssueOrPRLink } from '../github/links'
import type { GiteaIssueOrPRLink } from './gitea-links'
import {
  buildSmartWorkspaceUrlSourceRows,
  type SmartWorkspaceGitLabUrlIntent
} from './smart-workspace-url-source-results'
import { isSmartWorkspaceSourceQueryWithinLimit } from './smart-workspace-source-query'

export {
  SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES,
  isSmartWorkspaceSourceQueryWithinLimit
} from './smart-workspace-source-query'

export type SmartNameMode =
  | 'smart'
  | 'github'
  | 'gitlab'
  | 'gitea'
  | 'branches'
  | 'linear'
  | 'jira'
  | 'text'

export type SmartWorkspaceSourceRow =
  | { kind: 'use-name'; value: string; name: string }
  | { kind: 'create-branch'; value: string; name: string }
  | { kind: 'github'; value: string; item: GitHubWorkItem }
  | { kind: 'gitlab'; value: string; item: GitLabWorkItem }
  | { kind: 'gitea'; value: string; item: GiteaWorkItem }
  | { kind: 'branch'; value: string; refName: string; localBranchName: string }
  | { kind: 'linear'; value: string; issue: LinearIssue }
  | { kind: 'jira'; value: string; issue: JiraIssue }

type LinearIssueSourceInput = LinearIssue[] | LinearCollectionResult<LinearIssue> | null | undefined

const EMPTY_HINT_BY_MODE: Record<SmartNameMode, string> = {
  smart: 'Start typing to create a name or find a source.',
  github: 'Start typing to search GitHub PRs and issues.',
  gitlab: 'Start typing to search GitLab MRs and issues.',
  gitea: 'Start typing to search Gitea PRs and issues.',
  branches: 'No matching branches.',
  linear: 'Start typing to search Linear issues.',
  jira: 'Start typing to search Jira issues, or paste an issue URL.',
  text: ''
}

export function getSmartWorkspaceEmptyHint(mode: SmartNameMode): string {
  return EMPTY_HINT_BY_MODE[mode]
}

/** The trimmed query when it is short enough and has words to search for; null otherwise. */
export function getJiraIssueSearchQuery(query: string): string | null {
  const trimmed = query.trim()
  return isSmartWorkspaceSourceQueryWithinLimit(trimmed) && buildJiraTextMatchJql(trimmed)
    ? trimmed
    : null
}

export function isBlockingJiraUrlIntent(mode: SmartNameMode, value: string): boolean {
  return (mode === 'smart' || mode === 'jira') && parseJiraIssueUrl(value) !== null
}

export function isBlockingTaskUrlResolution({
  sourceIntent,
  isQueryStale,
  githubLoading,
  gitlabLoading,
  giteaLoading = false
}: {
  sourceIntent: 'github' | 'gitlab' | 'gitea' | null
  isQueryStale: boolean
  githubLoading: boolean
  gitlabLoading: boolean
  giteaLoading?: boolean
}): boolean {
  if (sourceIntent === null) {
    return false
  }
  if (isQueryStale) {
    return true
  }
  return sourceIntent === 'github'
    ? githubLoading
    : sourceIntent === 'gitlab'
      ? gitlabLoading
      : giteaLoading
}

function toJiraSourceRow(issue: JiraIssue): SmartWorkspaceSourceRow {
  return { kind: 'jira', value: `jira-${issue.siteId ?? ''}-${issue.key}`, issue }
}

function toGitHubSourceRow(item: GitHubWorkItem): SmartWorkspaceSourceRow {
  return { kind: 'github', value: `github-${item.repoId}-${item.type}-${item.number}`, item }
}

export {
  getBranchSearchRequest,
  getVisibleBranchResults,
  getVisibleHeldProviderResults,
  shouldHoldSourceResultsForQuery
} from './smart-workspace-source-visibility'

export function buildSmartWorkspaceSourceRows({
  branches,
  githubItems,
  githubUrlIntent,
  gitlabAvailable,
  gitlabItems,
  gitlabUrlIntent,
  giteaAvailable = false,
  giteaItems = [],
  giteaUrlIntent,
  jiraIntent = false,
  jiraIssue,
  jiraIssues = [],
  linearAvailable,
  linearIssues,
  linearUrlIntentOwnsResults = false,
  mode,
  resultLimit,
  value
}: {
  branches: BaseRefSearchResult[]
  githubItems: GitHubWorkItem[]
  githubUrlIntent?: GitHubIssueOrPRLink | null
  gitlabAvailable: boolean
  gitlabItems: GitLabWorkItem[]
  gitlabUrlIntent?: SmartWorkspaceGitLabUrlIntent | null
  giteaAvailable?: boolean
  giteaItems?: GiteaWorkItem[]
  giteaUrlIntent?: GiteaIssueOrPRLink | null
  jiraIntent?: boolean
  jiraIssue?: JiraIssue | null
  jiraIssues?: JiraIssue[]
  linearAvailable: boolean
  linearIssues: LinearIssueSourceInput
  linearUrlIntentOwnsResults?: boolean
  mode: SmartNameMode
  resultLimit: number
  value: string
}): SmartWorkspaceSourceRow[] {
  // Why: a pasted issue URL resolves to exactly one issue — every other source is noise.
  if (jiraIntent) {
    return jiraIssue ? [toJiraSourceRow(jiraIssue)] : []
  }
  if (!isSmartWorkspaceSourceQueryWithinLimit(value)) {
    return []
  }
  const resolvedLinearIssues = Array.isArray(linearIssues)
    ? linearIssues
    : Array.isArray(linearIssues?.items)
      ? linearIssues.items
      : []
  // Why: a full task URL is unambiguous, so unrelated held rows must never remain selectable.
  const urlSourceRows = buildSmartWorkspaceUrlSourceRows({
    githubItems,
    githubUrlIntent,
    gitlabAvailable,
    gitlabItems,
    gitlabUrlIntent,
    giteaAvailable,
    giteaItems,
    giteaUrlIntent,
    linearAvailable,
    linearIssues: resolvedLinearIssues,
    linearUrlIntentOwnsResults,
    mode,
    resultLimit,
    value
  })
  if (urlSourceRows !== null) {
    return urlSourceRows
  }
  const trimmed = value.trim()
  const nextRows: SmartWorkspaceSourceRow[] = []
  if (trimmed && mode === 'smart') {
    // Why: stable cmdk value — embedding the query remounted the row every keystroke.
    nextRows.push({ kind: 'use-name', value: 'use-name', name: trimmed })
  }
  if (mode === 'text') {
    return nextRows
  }
  if (mode === 'smart' || mode === 'github') {
    nextRows.push(...githubItems.map(toGitHubSourceRow))
  }
  if (gitlabAvailable && (mode === 'smart' || mode === 'gitlab')) {
    nextRows.push(
      ...gitlabItems.map((item) => ({
        kind: 'gitlab' as const,
        value: `gitlab-${item.repoId}-${item.type}-${item.number}`,
        item
      }))
    )
  }
  if (giteaAvailable && (mode === 'smart' || mode === 'gitea')) {
    nextRows.push(
      ...giteaItems.map((item) => ({
        kind: 'gitea' as const,
        value: `gitea-${item.repoId}-${item.type}-${item.number}`,
        item
      }))
    )
  }
  const shouldShowBranches = mode === 'branches' || (mode === 'smart' && trimmed.length > 0)
  if (shouldShowBranches) {
    const branchExactMatch = branches.some(
      (branch) => branch.refName === trimmed || branch.localBranchName === trimmed
    )
    if (trimmed && mode === 'branches' && !branchExactMatch) {
      nextRows.push({ kind: 'create-branch', value: 'create-branch', name: trimmed })
    }
    nextRows.push(
      ...branches.map((branch) => ({
        kind: 'branch' as const,
        value: `branch-${branch.refName}`,
        refName: branch.refName,
        localBranchName: branch.localBranchName
      }))
    )
  }
  if (linearAvailable && (mode === 'smart' || mode === 'linear')) {
    // Recover from mixed-version responses briefly returning paginated collections in this array render path.
    nextRows.push(
      ...resolvedLinearIssues.map((issue) => ({
        kind: 'linear' as const,
        value: `linear-${issue.id}`,
        issue
      }))
    )
  }
  if (mode === 'jira') {
    nextRows.push(...jiraIssues.map(toJiraSourceRow))
  }
  return nextRows.slice(0, resultLimit + 1)
}
