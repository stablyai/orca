import type {
  BaseRefSearchResult,
  GitHubWorkItem,
  GitLabWorkItem,
  LinearCollectionResult,
  LinearIssue
} from '../../../../shared/types'

export type SmartNameMode = 'smart' | 'github' | 'gitlab' | 'branches' | 'linear' | 'text'

export type SmartWorkspaceSourceRow =
  | { kind: 'use-name'; value: string; name: string }
  | { kind: 'create-branch'; value: string; name: string }
  | { kind: 'github'; value: string; item: GitHubWorkItem }
  | { kind: 'gitlab'; value: string; item: GitLabWorkItem }
  | { kind: 'branch'; value: string; refName: string; localBranchName: string }
  | { kind: 'linear'; value: string; issue: LinearIssue }

type LinearIssueSourceInput = LinearIssue[] | LinearCollectionResult<LinearIssue> | null | undefined

const EMPTY_HINT_BY_MODE: Record<SmartNameMode, string> = {
  smart: 'Start typing to create a name or find a source.',
  github: 'Start typing to search GitHub PRs and issues.',
  gitlab: 'Start typing to search GitLab MRs and issues.',
  branches: 'No matching branches.',
  linear: 'Start typing to search Linear issues.',
  text: ''
}

export function getSmartWorkspaceEmptyHint(mode: SmartNameMode): string {
  return EMPTY_HINT_BY_MODE[mode]
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
  const trimmedQuery = query.trim()
  const shouldSearchBranches = mode === 'branches' || (mode === 'smart' && trimmedQuery.length > 0)
  if (
    branchesEnabled === false ||
    disabled ||
    textOnly ||
    !selectedRepoId ||
    !shouldSearchBranches
  ) {
    return null
  }
  return { repoId: selectedRepoId, query: trimmedQuery, limit }
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
  const currentQuery = value.trim()
  if (mode !== 'branches' && mode !== 'smart') {
    return []
  }
  if (!selectedRepoId || resultRepoId !== selectedRepoId || resultQuery !== currentQuery) {
    return []
  }
  return branches
}

export function buildSmartWorkspaceSourceRows({
  branches,
  githubItems,
  gitlabAvailable,
  gitlabItems,
  linearAvailable,
  linearIssues,
  mode,
  resultLimit,
  value
}: {
  branches: BaseRefSearchResult[]
  githubItems: GitHubWorkItem[]
  gitlabAvailable: boolean
  gitlabItems: GitLabWorkItem[]
  linearAvailable: boolean
  linearIssues: LinearIssueSourceInput
  mode: SmartNameMode
  resultLimit: number
  value: string
}): SmartWorkspaceSourceRow[] {
  const trimmed = value.trim()
  const nextRows: SmartWorkspaceSourceRow[] = []
  if (trimmed && mode === 'smart') {
    nextRows.push({ kind: 'use-name', value: `use-name-${trimmed}`, name: trimmed })
  }
  if (mode === 'text') {
    return nextRows
  }
  if (mode === 'smart' || mode === 'github') {
    nextRows.push(
      ...githubItems.map((item) => ({
        kind: 'github' as const,
        value: `github-${item.type}-${item.number}`,
        item
      }))
    )
  }
  if (gitlabAvailable && (mode === 'smart' || mode === 'gitlab')) {
    nextRows.push(
      ...gitlabItems.map((item) => ({
        kind: 'gitlab' as const,
        value: `gitlab-${item.type}-${item.number}`,
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
      nextRows.push({ kind: 'create-branch', value: `create-branch-${trimmed}`, name: trimmed })
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
    const resolvedLinearIssues = Array.isArray(linearIssues)
      ? linearIssues
      : Array.isArray(linearIssues?.items)
        ? linearIssues.items
        : []
    nextRows.push(
      ...resolvedLinearIssues.map((issue) => ({
        kind: 'linear' as const,
        value: `linear-${issue.id}`,
        issue
      }))
    )
  }
  return nextRows.slice(0, resultLimit + 1)
}
