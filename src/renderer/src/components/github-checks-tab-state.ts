import type { PRCheckDetail, PRCheckRunDetails } from '../../../shared/types'

export type CheckDetailsLoadState = {
  loading: boolean
  details: PRCheckRunDetails | null
  error: string | null
}

export type GitHubChecksTabState = {
  sourceChecks: GitHubChecksSource
  localChecks: PRCheckDetail[] | null
  expandedCheckKey: string | null
  detailsByCheckKey: Record<string, CheckDetailsLoadState>
}

type GitHubChecksSource = readonly PRCheckDetail[] | null | undefined

export function createGitHubChecksTabState(sourceChecks: GitHubChecksSource): GitHubChecksTabState {
  return {
    sourceChecks,
    localChecks: null,
    expandedCheckKey: null,
    detailsByCheckKey: {}
  }
}

export function resolveGitHubChecksTabState(
  state: GitHubChecksTabState,
  sourceChecks: GitHubChecksSource
): GitHubChecksTabState {
  return state.sourceChecks === sourceChecks ? state : createGitHubChecksTabState(sourceChecks)
}

export function updateGitHubChecksTabLocalChecks(
  state: GitHubChecksTabState,
  localChecks: PRCheckDetail[]
): GitHubChecksTabState {
  return {
    ...state,
    localChecks
  }
}

export function toggleGitHubChecksTabExpandedKey(
  state: GitHubChecksTabState,
  key: string
): GitHubChecksTabState {
  return {
    ...state,
    expandedCheckKey: state.expandedCheckKey === key ? null : key
  }
}

export function updateGitHubChecksTabDetails(
  state: GitHubChecksTabState,
  key: string,
  details: CheckDetailsLoadState
): GitHubChecksTabState {
  return {
    ...state,
    detailsByCheckKey: {
      ...state.detailsByCheckKey,
      [key]: details
    }
  }
}
