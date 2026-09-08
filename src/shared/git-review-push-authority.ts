import { parseGitHubRemoteIdentity } from './github/remote-identity-parsing'
import { parseRemoteProjectRefCandidate } from './gitlab-project-ref-parser'
import { normalizeGitLabRemoteHost } from './git-remote-host-alias'
import { parseGitRemoteVerboseLine } from './git-remote-url-index'
import type { GitPushTarget, GitReviewHead } from './worktree/types'

type GitRunner = (args: string[]) => Promise<{ stdout: string }>
export type GitReviewPushAuthority = {
  kind: 'verified' | 'unresolved' | 'ambiguous' | 'unverifiable' | 'mismatch'
  reviewHead?: GitReviewHead
}

export function reviewHeadKey(head: GitReviewHead | undefined): string | undefined {
  return head
    ? JSON.stringify([
        head.provider,
        head.host.toLowerCase(),
        head.repository.toLowerCase(),
        head.branchName
      ])
    : undefined
}

function endpointMatchesHead(endpoint: string, head: GitReviewHead): boolean {
  if (head.provider === 'github') {
    const identity = parseGitHubRemoteIdentity(endpoint)
    return (
      !!identity &&
      identity.host.toLowerCase() === head.host.toLowerCase() &&
      `${identity.owner}/${identity.repo}`.toLowerCase() === head.repository.toLowerCase()
    )
  }
  const identity = parseRemoteProjectRefCandidate(endpoint)
  return (
    !!identity &&
    normalizeGitLabRemoteHost(identity.host) === head.host.toLowerCase() &&
    identity.path.toLowerCase() === head.repository.toLowerCase()
  )
}

// Always read through the execution host; persisted hydration and fetch URLs are not push evidence.
export async function readGitReviewPushAuthority(
  runGit: GitRunner,
  target: GitPushTarget
): Promise<GitReviewPushAuthority> {
  const reviewHead = target.reviewHead
  if (!reviewHead) {
    return { kind: 'unresolved' }
  }
  if (reviewHead.branchName !== target.branchName) {
    return { kind: 'mismatch', reviewHead }
  }
  try {
    const { stdout } = await runGit(['remote', '-v'])
    const entries = stdout
      .split(/\r?\n/)
      .map(parseGitRemoteVerboseLine)
      .filter((entry) => entry !== null)
    if (entries.length > 512 || new Set(entries.map((entry) => entry.name)).size > 128) {
      return { kind: 'unverifiable', reviewHead }
    }
    const endpoints = entries.filter(
      (entry) => entry.name === target.remoteName && entry.direction === 'push'
    )
    if (endpoints.length > 1) {
      return { kind: 'ambiguous', reviewHead }
    }
    if (!endpoints[0]) {
      return { kind: 'unverifiable', reviewHead }
    }
    return {
      kind: endpointMatchesHead(endpoints[0].url, reviewHead) ? 'verified' : 'mismatch',
      reviewHead
    }
  } catch {
    return { kind: 'unverifiable', reviewHead }
  }
}

export async function assertGitReviewPushAuthority(
  runGit: GitRunner,
  target: GitPushTarget
): Promise<void> {
  const result = await readGitReviewPushAuthority(runGit, target)
  if (result.kind !== 'verified') {
    throw new Error(
      `Review push endpoint authority is ${result.kind}. Resolve the review target and remote configuration before retrying.`
    )
  }
}
