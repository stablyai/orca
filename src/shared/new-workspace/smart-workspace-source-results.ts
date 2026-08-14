import type {
  BaseRefSearchResult,
  GitHubWorkItem,
  GitLabWorkItem,
  JiraIssue,
  LinearCollectionResult,
  LinearIssue
} from '../types'
import { JIRA_ISSUE_KEY_PATTERN, parseJiraIssueUrl } from '../jira-issue-url'
import {
  isSmartWorkspaceLinearIssueIntentMatch,
  parseBoundedSmartWorkspaceLinearIssueUrlIntent
} from './smart-workspace-linear-intent'
import { isSmartWorkspaceSourceQueryWithinLimit } from './smart-workspace-source-query'

export {
  SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES,
  isSmartWorkspaceSourceQueryWithinLimit
} from './smart-workspace-source-query'

export type SmartNameMode = 'smart' | 'github' | 'gitlab' | 'branches' | 'linear' | 'jira' | 'text'

export type SmartWorkspaceSourceRow =
  | { kind: 'use-name'; value: string; name: string }
  | { kind: 'create-branch'; value: string; name: string }
  | { kind: 'github'; value: string; item: GitHubWorkItem }
  | { kind: 'gitlab'; value: string; item: GitLabWorkItem }
  | { kind: 'branch'; value: string; refName: string; localBranchName: string }
  | { kind: 'linear'; value: string; issue: LinearIssue }
  | { kind: 'jira'; value: string; issue: JiraIssue }

type LinearIssueSourceInput = LinearIssue[] | LinearCollectionResult<LinearIssue> | null | undefined

const EMPTY_HINT_BY_MODE: Record<SmartNameMode, string> = {
  smart: 'Start typing to create a name or find a source.',
  github: 'Start typing to search GitHub PRs and issues.',
  gitlab: 'Start typing to search GitLab MRs and issues.',
  branches: 'No matching branches.',
  linear: 'Start typing to search Linear issues.',
  jira: 'Start typing to search Jira issues, or paste an issue URL.',
  text: ''
}

export function getSmartWorkspaceEmptyHint(mode: SmartNameMode): string {
  return EMPTY_HINT_BY_MODE[mode]
}

export function buildJiraIssueSearchJql(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed || !isSmartWorkspaceSourceQueryWithinLimit(trimmed)) {
    return null
  }
  if (JIRA_ISSUE_KEY_PATTERN.test(trimmed)) {
    return `key = "${trimmed.toUpperCase()}"`
  }
  const escaped = trimmed.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `text ~ "${escaped}*"`
}

export function isBlockingJiraUrlIntent(mode: SmartNameMode, value: string): boolean {
  return (mode === 'smart' || mode === 'jira') && parseJiraIssueUrl(value) !== null
}

function toJiraSourceRow(issue: JiraIssue): SmartWorkspaceSourceRow {
  return { kind: 'jira', value: `jira-${issue.siteId ?? ''}-${issue.key}`, issue }
}

export function getBranchSearchRequest({
  branchesEnabled,
  disabled,
  textOnly,
  mode,
  selectedRepoId,
  query,
  limit
}: {
  branchesEnabled?: boolean
  disabled: boolean
  textOnly: boolean
  mode: SmartNameMode
  selectedRepoId: string | null
  query: string
  limit: number
}): { repoId: string; query: string; limit: number } | null {
  if (
    branchesEnabled === false ||
    disabled ||
    textOnly ||
    !isSmartWorkspaceSourceQueryWithinLimit(query) ||
    !selectedRepoId
  ) {
    return null
  }
  const trimmedQuery = query.trim()
  const shouldSearchBranches = mode === 'branches' || (mode === 'smart' && trimmedQuery.length > 0)
  if (!shouldSearchBranches) {
    return null
  }
  return { repoId: selectedRepoId, query: trimmedQuery, limit }
}

/**
 * Why: provider arrays lag the live input (200ms debounce). Keep them while the
 * user is still typing, but hide immediately when the field is cleared so prior
 * non-empty results cannot stay selectable until debounce catches up.
 */
export function getVisibleHeldProviderResults<T>({
  items,
  value,
  debouncedQuery
}: {
  items: readonly T[]
  value: string
  debouncedQuery: string
}): T[] {
  if (!isSmartWorkspaceSourceQueryWithinLimit(value)) {
    return []
  }
  if (value.trim() === '' && debouncedQuery.trim() !== '') {
    return []
  }
  return items.slice()
}

export function getVisibleBranchResults({
  branches,
  mode,
  resultRepoId,
  resultQuery,
  selectedRepoId,
  value
}: {
  branches: BaseRefSearchResult[]
  mode: SmartNameMode
  resultRepoId: string | null
  resultQuery: string | null
  selectedRepoId: string | null
  value: string
}): BaseRefSearchResult[] {
  if (!isSmartWorkspaceSourceQueryWithinLimit(value)) {
    return []
  }
  if (mode !== 'branches' && mode !== 'smart') {
    return []
  }
  if (!selectedRepoId || resultRepoId !== selectedRepoId || resultQuery === null) {
    return []
  }
  const currentQuery = value.trim()
  // Why: hold the last settled list while the user extends/trims the query so the
  // dropdown does not blank between debounced keystrokes. Drop the hold when the
  // query diverges (e.g. "feat" → "bug") so unrelated rows do not linger.
  if (currentQuery === '') {
    return resultQuery === '' ? branches : []
  }
  if (!shouldHoldSourceResultsForQuery({ resultQuery, value: currentQuery })) {
    return []
  }
  return branches
}

/** Max |live − settled| length while still treating a prefix as "still typing". */
const SOURCE_RESULT_HOLD_MAX_DELTA = 4

/**
 * Why: prefix-only hold lets a settled "f" stick under "fix-unrelated-…" for the
 * whole next debounce. Cap the length delta so hold covers fast typing, not long
 * continuations of a short settled query.
 */
export function shouldHoldSourceResultsForQuery({
  resultQuery,
  value
}: {
  resultQuery: string
  value: string
}): boolean {
  const currentQueryKey = value.trim().toLowerCase()
  const resultQueryKey = resultQuery.trim().toLowerCase()
  if (resultQueryKey === currentQueryKey) {
    return true
  }
  if (!currentQueryKey.startsWith(resultQueryKey) && !resultQueryKey.startsWith(currentQueryKey)) {
    return false
  }
  return Math.abs(currentQueryKey.length - resultQueryKey.length) <= SOURCE_RESULT_HOLD_MAX_DELTA
}

export function buildSmartWorkspaceSourceRows({
  branches,
  githubItems,
  gitlabAvailable,
  gitlabItems,
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
  gitlabAvailable: boolean
  gitlabItems: GitLabWorkItem[]
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
  const trimmed = value.trim()
  const nextRows: SmartWorkspaceSourceRow[] = []
  const resolvedLinearIssues = Array.isArray(linearIssues)
    ? linearIssues
    : Array.isArray(linearIssues?.items)
      ? linearIssues.items
      : []
  const linearUrlIntent = parseBoundedSmartWorkspaceLinearIssueUrlIntent(trimmed)
  if (
    linearUrlIntentOwnsResults &&
    linearAvailable &&
    linearUrlIntent &&
    (mode === 'smart' || mode === 'linear')
  ) {
    const linearRows = resolvedLinearIssues
      .filter((issue) => isSmartWorkspaceLinearIssueIntentMatch(linearUrlIntent, issue))
      .map((issue) => ({
        kind: 'linear' as const,
        value: `linear-${issue.id}`,
        issue
      }))
      .slice(0, resultLimit)
    // Why: keep "use as workspace name" available; sourceIntent focuses the issue.
    if (trimmed && mode === 'smart') {
      return [{ kind: 'use-name' as const, value: 'use-name', name: trimmed }, ...linearRows]
    }
    return linearRows
  }
  if (trimmed && mode === 'smart') {
    // Why: stable cmdk value — embedding the query remounted the row every keystroke.
    nextRows.push({ kind: 'use-name', value: 'use-name', name: trimmed })
  }
  if (mode === 'text') {
    return nextRows
  }
  if (mode === 'smart' || mode === 'github') {
    nextRows.push(
      ...githubItems.map((item) => ({
        kind: 'github' as const,
        value: `github-${item.repoId}-${item.type}-${item.number}`,
        item
      }))
    )
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
    // Why: mixed-version runtime responses may briefly carry the paginated
    // collection shape into this render path; rendering must stay recoverable.
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
