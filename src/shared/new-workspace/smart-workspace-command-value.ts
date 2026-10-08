export type SmartWorkspaceCommandRowKind =
  | 'use-name'
  | 'create-branch'
  | 'github'
  | 'gitlab'
  | 'branch'
  | 'linear'
  | 'jira'
  | 'jira-account'

export type SmartWorkspaceCommandRow = {
  kind: SmartWorkspaceCommandRowKind
  value: string
}

export type SmartWorkspaceSourceIntent = 'github' | 'gitlab' | 'linear' | 'jira' | null

export function resolveSmartWorkspaceCommandValue({
  currentValue,
  rows,
  isQueryStale,
  sourceIntent,
  branchIntentValue = null
}: {
  currentValue: string
  rows: readonly SmartWorkspaceCommandRow[]
  isQueryStale: boolean
  sourceIntent: SmartWorkspaceSourceIntent
  branchIntentValue?: string | null
}): string {
  if (rows.length === 0) {
    return currentValue
  }

  // Why: freeze the arm while the live input is ahead of debounced search so the
  // highlight does not thrash to use-name / empty / first-row on every keystroke.
  if (isQueryStale) {
    const typedTextRow = rows.find((row) => row.kind === 'use-name' || row.kind === 'create-branch')
    if (typedTextRow) {
      return typedTextRow.value
    }
    return rows.some((row) => row.value === currentValue) ? currentValue : (rows[0]?.value ?? '')
  }

  if (sourceIntent === 'github') {
    const githubRow = rows.find((row) => row.kind === 'github')
    if (githubRow) {
      return githubRow.value
    }
  } else if (sourceIntent === 'gitlab') {
    const gitlabRow = rows.find((row) => row.kind === 'gitlab')
    if (gitlabRow) {
      return gitlabRow.value
    }
  } else if (sourceIntent === 'linear') {
    const linearRow = rows.find((row) => row.kind === 'linear')
    if (linearRow) {
      return linearRow.value
    }
  } else if (sourceIntent === 'jira') {
    const jiraRow = rows.find((row) => row.kind === 'jira')
    if (jiraRow) {
      return jiraRow.value
    }
  }

  if (branchIntentValue !== null && rows.some((row) => row.value === branchIntentValue)) {
    return branchIntentValue
  }

  return rows.some((row) => row.value === currentValue) ? currentValue : rows[0].value
}

export type SmartWorkspaceBranchRef = {
  refName: string
  localBranchName: string
}

/**
 * Issue #18701: the branch ref the typed text names unambiguously — an exact
 * branch name, or a prefix of exactly one branch. Local and remote refs sharing a
 * local branch name count as one branch. Matching is case-sensitive like the host's
 * ref search, and a prefix only counts when the search returned less than a full
 * page, since otherwise a hidden ref could also match. Null keeps the typed text.
 */
export function findSmartWorkspaceBranchIntentRef(
  query: string,
  branches: readonly SmartWorkspaceBranchRef[],
  resultLimit: number
): string | null {
  const needle = query.trim()
  if (!needle) {
    return null
  }
  const pickUnique = (matches: readonly SmartWorkspaceBranchRef[]): string | null =>
    matches.length > 0 && new Set(matches.map((ref) => ref.localBranchName)).size === 1
      ? matches[0].refName
      : null
  const exactMatches = branches.filter(
    (ref) => ref.localBranchName === needle || ref.refName === needle
  )
  if (exactMatches.length > 0) {
    return pickUnique(exactMatches)
  }
  if (branches.length >= resultLimit) {
    return null
  }
  return pickUnique(
    branches.filter(
      (ref) => ref.localBranchName.startsWith(needle) || ref.refName.startsWith(needle)
    )
  )
}
