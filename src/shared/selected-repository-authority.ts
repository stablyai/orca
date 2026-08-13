import { normalizeRuntimePathForComparison } from './cross-platform-path'

export type SelectedRepositoryAuthority = Readonly<{
  path: string
  connectionId: string | null
}>

export type SelectedRepositoryAuthorityCandidate = Readonly<{
  path: string
  connectionId?: string | null
}>

export type SelectedRepositoryAuthorityResolution<T> =
  | { status: 'legacy-selection' }
  | { status: 'resolved'; candidate: T }
  | { status: 'rejected'; reason: 'no-match' | 'ambiguous'; matchCount: number }

function normalizeConnectionId(value: string | null | undefined): string | null {
  return value?.trim() || null
}

export function resolveSelectedRepositoryAuthority<T extends SelectedRepositoryAuthorityCandidate>(
  candidates: readonly T[],
  authority?: SelectedRepositoryAuthority | null
): SelectedRepositoryAuthorityResolution<T> {
  if (authority == null) {
    return { status: 'legacy-selection' }
  }

  const authorityPath = normalizeRuntimePathForComparison(authority.path)
  const authorityConnectionId = normalizeConnectionId(authority.connectionId)
  const matches = candidates.filter(
    (candidate) =>
      normalizeRuntimePathForComparison(candidate.path) === authorityPath &&
      normalizeConnectionId(candidate.connectionId) === authorityConnectionId
  )

  if (matches.length === 1) {
    return { status: 'resolved', candidate: matches[0] }
  }
  return {
    status: 'rejected',
    reason: matches.length === 0 ? 'no-match' : 'ambiguous',
    matchCount: matches.length
  }
}
