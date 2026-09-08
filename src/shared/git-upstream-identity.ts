import type { GitOperationSelector } from './git-operation-selector'

export type GitUpstreamIdentity = {
  selector: GitOperationSelector | { kind: 'local'; value: '.' }
  mergeRef: string
  branchName: string
  trackingRef: string | null
}

export function gitBranchNameFromFullRef(ref: string | null | undefined): string | null {
  return ref?.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length
    ? ref.slice('refs/heads/'.length)
    : null
}

// Configured intent and optional local tracking evidence have different owners.
export function gitUpstreamIdentity(
  selector: GitUpstreamIdentity['selector'],
  mergeRef: string | null | undefined,
  trackingRef: string | null = null
): GitUpstreamIdentity | null {
  const branchName = gitBranchNameFromFullRef(mergeRef)
  return branchName && mergeRef ? { selector, mergeRef, branchName, trackingRef } : null
}

export function gitTrackingRefDisplayName(ref: string): string {
  for (const prefix of ['refs/remotes/', 'refs/heads/']) {
    if (ref.startsWith(prefix)) {
      return ref.slice(prefix.length)
    }
  }
  return ref
}

// Literal selectors can contain credentials; publish their kind, never their value.
export type GitUpstreamStatusIdentity = {
  selector: { kind: 'named-remote'; value: string } | { kind: 'literal-url' } | { kind: 'local' }
  mergeRef: string
  trackingRef: string | null
}

export function projectGitUpstreamIdentity(
  identity: GitUpstreamIdentity
): GitUpstreamStatusIdentity {
  return {
    selector:
      identity.selector.kind === 'named-remote'
        ? identity.selector
        : { kind: identity.selector.kind },
    mergeRef: identity.mergeRef,
    trackingRef: identity.trackingRef
  }
}

export function areGitUpstreamIdentitiesEqual(
  previous: GitUpstreamStatusIdentity | undefined,
  next: GitUpstreamStatusIdentity | undefined
): boolean {
  return (
    previous === next ||
    Boolean(
      previous &&
      next &&
      previous.mergeRef === next.mergeRef &&
      previous.trackingRef === next.trackingRef &&
      previous.selector.kind === next.selector.kind &&
      (previous.selector.kind !== 'named-remote' ||
        (next.selector.kind === 'named-remote' && previous.selector.value === next.selector.value))
    )
  )
}
