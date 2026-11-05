import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../shared/github/check-types'

export type CheckDetailsLoadState = {
  requestId?: number
  loading: boolean
  details: PRCheckRunDetails | null
  error: string | null
}

declare const checksContextOwnerBrand: unique symbol

/** Identity minted per checks context; only its reference is ever compared. */
export type GitHubChecksContextOwner = object & { readonly [checksContextOwnerBrand]?: never }

export type GitHubChecksTabState = {
  contextKey: string
  contextOwner: GitHubChecksContextOwner
  sourceChecks: GitHubChecksSource
  checkObservationOwner?: GitHubWorkItem
  localChecks: PRCheckDetail[] | null
  expandedCheckKey: string | null
  detailsByCheckKey: Record<string, CheckDetailsLoadState>
}

type GitHubChecksSource = readonly PRCheckDetail[] | null | undefined

export function createGitHubChecksTabState(
  sourceChecks: GitHubChecksSource,
  contextKey: string
): GitHubChecksTabState {
  return {
    contextKey,
    contextOwner: {},
    sourceChecks,
    localChecks: null,
    expandedCheckKey: null,
    detailsByCheckKey: {}
  }
}

export function resolveGitHubChecksTabState(
  state: GitHubChecksTabState,
  sourceChecks: GitHubChecksSource,
  contextKey: string
): GitHubChecksTabState {
  if (state.contextKey !== contextKey) {
    return createGitHubChecksTabState(sourceChecks, contextKey)
  }
  if (state.sourceChecks === sourceChecks) {
    return state
  }
  const reset = resetGitHubChecksTabForSource(state, sourceChecks)
  return sourceChecks === state.localChecks
    ? { ...reset, checkObservationOwner: state.checkObservationOwner }
    : reset
}

export function resetGitHubChecksTabForSource(
  state: GitHubChecksTabState,
  sourceChecks: GitHubChecksSource = state.sourceChecks
): GitHubChecksTabState {
  return {
    contextKey: state.contextKey,
    contextOwner: state.contextOwner,
    sourceChecks,
    localChecks: null,
    expandedCheckKey: null,
    detailsByCheckKey: {}
  }
}

export function updateGitHubChecksTabLocalChecks(
  state: GitHubChecksTabState,
  localChecks: PRCheckDetail[],
  checkObservationOwner?: GitHubWorkItem
): GitHubChecksTabState {
  return {
    ...state,
    localChecks,
    checkObservationOwner
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

/** Writes without requestId retire in-flight settlements; use beginGitHubChecksTabDetails when a result must settle. */
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

export function beginGitHubChecksTabDetails(
  state: GitHubChecksTabState,
  key: string,
  requestId: number
): GitHubChecksTabState {
  const current = state.detailsByCheckKey[key]
  return updateGitHubChecksTabDetails(state, key, {
    requestId,
    loading: true,
    details: null,
    error: current?.error ?? null
  })
}

/** Context swaps clear owning entries so requests from the old context cannot settle. */
export function settleGitHubChecksTabDetails(
  state: GitHubChecksTabState,
  key: string,
  requestId: number,
  details: Omit<CheckDetailsLoadState, 'requestId'>
): GitHubChecksTabState {
  if (state.detailsByCheckKey[key]?.requestId !== requestId) {
    return state
  }
  return updateGitHubChecksTabDetails(state, key, { ...details, requestId })
}
