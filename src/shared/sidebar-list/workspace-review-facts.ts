import { z } from 'zod'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { getGitHubPRCacheKeyCandidates } from '../github/github-cache-key'
import { isGitHubPRSuppressed } from '../worktree/github-pr-suppression'
import { getPRGroupKeyForState, type PRGroupKey } from '../workspace-view/workspace-pr-groups'
import type { PairedServerWorkspaceRow } from './paired-server-rows'
import { parseExecutionHostId } from '../execution-host'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'
import { listGitWorkspaceRows } from './workspace-rows'
import { UNCACHED_LINKED_PR_STATE } from '../runtime-worktree-contracts'

/** PR grouping currently admits only GitHub facts. */
const WorkspaceReviewFactSchema = z.object({
  provider: z.literal('github'),
  reviewState: z.string()
})

/** On-demand facts have no revision; absent row key means no PR. */
export const WorkspaceReviewFactsSnapshotSchema = z.object({
  facts: z.record(z.string(), WorkspaceReviewFactSchema)
})

export type WorkspaceReviewFact = z.infer<typeof WorkspaceReviewFactSchema>
export type WorkspaceReviewFactsSnapshot = z.infer<typeof WorkspaceReviewFactsSnapshotSchema>

type CachedPR = { number?: number; state?: string }

/** The window's PR cache, or main's persisted copy of it. */
export type PRCacheView<T extends CachedPR = CachedPR> = Readonly<
  Record<string, { data: T | null } | undefined>
>

/** Cached PR for the workspace branch, excluding one the user unlinked. */
export function readWorkspaceReviewPR<T extends CachedPR>(
  worktree: Pick<Worktree, 'branch' | 'linkedPR' | 'suppressedGitHubPR'>,
  repo: Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> | undefined,
  prCache: PRCacheView<T>
): T | null {
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  if (!repo || !branch) {
    return null
  }
  const keys = getGitHubPRCacheKeyCandidates(repo, branch)
  // Legacy keys lack host identity; only local repos may use them.
  const lookup = !repo.connectionId && !repo.executionHostId ? keys : keys.slice(0, 1)
  const entry = lookup.map((key) => prCache[key]).find((candidate) => candidate != null)
  const pr = entry?.data
  if (!pr || (typeof pr.number === 'number' && isGitHubPRSuppressed(worktree, pr.number))) {
    return null
  }
  return pr
}

export function readWorkspaceReviewFact(
  worktree: Pick<Worktree, 'branch' | 'linkedPR' | 'suppressedGitHubPR'>,
  repo: Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> | undefined,
  prCache: PRCacheView
): WorkspaceReviewFact | null {
  const pr = readWorkspaceReviewPR(worktree, repo, prCache)
  return pr ? { provider: 'github', reviewState: pr.state ?? '' } : null
}

export function prGroupOfReviewFact(fact: WorkspaceReviewFact | null | undefined): PRGroupKey {
  return fact ? getPRGroupKeyForState(fact.reviewState) : 'in-progress'
}

/** PR lane for a worktree.ps row, whose uncached linked PR carries no review fact. */
export function prGroupOfPsLinkedPR(linkedPR: { state: string } | null | undefined): PRGroupKey {
  return linkedPR && linkedPR.state !== UNCACHED_LINKED_PR_STATE
    ? getPRGroupKeyForState(linkedPR.state)
    : 'in-progress'
}

export function workspaceReviewFactsEqual(
  a: WorkspaceReviewFact | null | undefined,
  b: WorkspaceReviewFact | null | undefined
): boolean {
  return a?.provider === b?.provider && a?.reviewState === b?.reviewState
}

/** Read each listed worktree with its own repo, keyed by row identity. */
export function buildWorkspaceReviewFacts(
  worktrees: readonly Pick<
    Worktree,
    'id' | 'repoId' | 'hostId' | 'branch' | 'linkedPR' | 'suppressedGitHubPR'
  >[],
  repos: readonly Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'>[],
  prCache: PRCacheView
): Record<HostScopedWorktreeKey, WorkspaceReviewFact> {
  const facts: Record<HostScopedWorktreeKey, WorkspaceReviewFact> = {}
  for (const { identity, worktree, repo } of listGitWorkspaceRows(worktrees, repos)) {
    const fact = readWorkspaceReviewFact(worktree, repo, prCache)
    if (fact) {
      facts[identity] = fact
    }
  }
  return facts
}

/** Read paired-server rows against this desktop’s cache using server-scoped keys. */
export function buildPairedServerReviewFacts(
  servers: readonly { hostId: string; rows: readonly PairedServerWorkspaceRow[] }[],
  prCache: PRCacheView
): Record<HostScopedWorktreeKey, WorkspaceReviewFact> {
  const facts: Record<HostScopedWorktreeKey, WorkspaceReviewFact> = {}
  for (const server of servers) {
    const hostId = parseExecutionHostId(server.hostId)?.id
    for (const row of hostId ? server.rows : []) {
      const fact =
        row.kind === 'git'
          ? readWorkspaceReviewFact(
              { branch: row.branch, linkedPR: null },
              { id: row.repoId, path: '', executionHostId: hostId },
              prCache
            )
          : null
      if (fact) {
        facts[composeWorktreeHostIdentity(hostId, row.worktreeId)] = fact
      }
    }
  }
  return facts
}
