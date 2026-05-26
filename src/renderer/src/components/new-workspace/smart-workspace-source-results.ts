import type {
  BaseRefSearchResult,
  GitHubWorkItem,
  GitLabWorkItem,
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

export function shouldQueryBranchMode({
  textOnly,
  mode
}: {
  textOnly: boolean
  mode: SmartNameMode
}): boolean {
  return !textOnly && (mode === 'smart' || mode === 'branches')
}

export function getBranchSearchRequest({
  disabled,
  textOnly,
  mode,
  selectedRepoId,
  query,
  limit
}: {
  disabled: boolean
  textOnly: boolean
  mode: SmartNameMode
  selectedRepoId: string | null
  query: string
  limit: number
}): { repoId: string; query: string; limit: number } | null {
  if (disabled || !selectedRepoId || !shouldQueryBranchMode({ textOnly, mode })) {
    return null
  }
  return { repoId: selectedRepoId, query: query.trim(), limit }
}

export function shouldOpenSmartWorkspacePopoverOnModeChange({
  disabled,
  mode
}: {
  disabled: boolean
  mode: SmartNameMode
}): boolean {
  return !disabled && mode !== 'text'
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
  linearIssues: LinearIssue[]
  mode: SmartNameMode
  resultLimit: number
  value: string
}): SmartWorkspaceSourceRow[] {
  const trimmed = value.trim()
  const branchExactMatch =
    mode === 'branches' &&
    trimmed.length > 0 &&
    branches.some((branch) => branch.refName === trimmed || branch.localBranchName === trimmed)
  const useNameRow: SmartWorkspaceSourceRow | null =
    trimmed && mode === 'smart'
      ? { kind: 'use-name', value: `use-name-${trimmed}`, name: trimmed }
      : null
  const createBranchRow: SmartWorkspaceSourceRow | null =
    trimmed && mode === 'branches' && !branchExactMatch
      ? { kind: 'create-branch', value: `create-branch-${trimmed}`, name: trimmed }
      : null
  const nextRows: SmartWorkspaceSourceRow[] = []
  if (useNameRow) {
    nextRows.push(useNameRow)
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
  if (mode === 'smart' || mode === 'branches') {
    if (createBranchRow) {
      nextRows.push(createBranchRow)
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
    nextRows.push(
      ...linearIssues.map((issue) => ({
        kind: 'linear' as const,
        value: `linear-${issue.id}`,
        issue
      }))
    )
  }
  return nextRows.slice(0, resultLimit + 1)
}
