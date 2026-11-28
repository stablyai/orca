import { branchRefLabel } from '../git/refs/branch-ref-label'

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

  // Keep selection stable while live text leads debounced results, avoiding highlight changes on each keystroke.
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
 * Resolve an unambiguous typed branch intent (exact ref/local name, or a prefix matching one
 * logical branch on a partial page) so Enter selects the branch rather than creating a misnamed one.
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
  const pickUnique = (matches: readonly SmartWorkspaceBranchRef[]): string | null => {
    if (matches.length === 0 || new Set(matches.map((ref) => ref.localBranchName)).size !== 1) {
      return null
    }
    const remotes = new Set(
      matches.flatMap((ref) => {
        const prefix = 'refs/remotes/'
        if (!ref.refName.startsWith(prefix)) {
          return []
        }
        const rest = ref.refName.slice(prefix.length)
        const suffix = `/${ref.localBranchName}`
        if (rest.endsWith(suffix) && rest.length > suffix.length) {
          return [rest.slice(0, -suffix.length)]
        }
        return [ref.refName]
      })
    )
    return remotes.size <= 1 ? matches[0].refName : null
  }
  const exactMatches = branches.filter(
    (ref) =>
      ref.localBranchName === needle ||
      ref.refName === needle ||
      branchRefLabel(ref.refName) === needle
  )
  if (exactMatches.length > 0) {
    return pickUnique(exactMatches)
  }
  if (branches.length >= resultLimit) {
    return null
  }
  return pickUnique(
    branches.filter(
      (ref) =>
        ref.localBranchName.startsWith(needle) ||
        ref.refName.startsWith(needle) ||
        branchRefLabel(ref.refName).startsWith(needle)
    )
  )
}
