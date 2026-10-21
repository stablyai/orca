import { z } from 'zod'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { getGitHubPRCacheKeyCandidates } from '../github/github-cache-key'
import { isGitHubPRSuppressed } from '../worktree/github-pr-suppression'
import { getPRGroupKeyForState, type PRGroupKey } from '../workspace-view/workspace-pr-groups'
import type { PairedServerWorkspaceRow } from './paired-server-rows'
import { parseExecutionHostId } from '../execution-host'

/** Grouping by PR reads GitHub PRs only, so only a row with a GitHub PR carries a fact. */
const WorkspaceReviewFactSchema = z.object({
  provider: z.literal('github'),
  reviewState: z.string()
})

/** Read on demand, so it carries no revision. An absent id has no PR. */
export const WorkspaceReviewFactsSnapshotSchema = z.object({
  facts: z.record(z.string(), WorkspaceReviewFactSchema)
})

export type WorkspaceReviewFact = z.infer<typeof WorkspaceReviewFactSchema>
export type WorkspaceReviewFactsSnapshot = z.infer<typeof WorkspaceReviewFactsSnapshotSchema>

/** The window's PR cache, or main's persisted copy of it. */
export type PRCacheView = Readonly<
  Record<string, { data: { number?: number; state?: string } | null } | undefined>
>

/** A worktree's PR as the cache holds it, minus a PR the user unlinked. */
export function readWorkspaceReviewFact(
  worktree: Pick<Worktree, 'branch' | 'linkedPR' | 'suppressedGitHubPR'>,
  repo: Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> | undefined,
  prCache: PRCacheView
): WorkspaceReviewFact | null {
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  if (!repo || !branch) {
    return null
  }
  const keys = getGitHubPRCacheKeyCandidates(repo, branch)
  // Why: legacy keys carry no host, so only a local repo may read them.
  const lookup = !repo.connectionId && !repo.executionHostId ? keys : keys.slice(0, 1)
  const entry = lookup.map((key) => prCache[key]).find((candidate) => candidate != null)
  const pr = entry?.data
  if (!pr || (typeof pr.number === 'number' && isGitHubPRSuppressed(worktree, pr.number))) {
    return null
  }
  return { provider: 'github', reviewState: pr.state ?? '' }
}

export function prGroupOfReviewFact(fact: WorkspaceReviewFact | null | undefined): PRGroupKey {
  return fact ? getPRGroupKeyForState(fact.reviewState) : 'in-progress'
}

export function workspaceReviewFactsEqual(
  a: WorkspaceReviewFact | null | undefined,
  b: WorkspaceReviewFact | null | undefined
): boolean {
  return a?.provider === b?.provider && a?.reviewState === b?.reviewState
}

/** Facts for every worktree with a PR; the window and main run this over their own copies. */
export function buildWorkspaceReviewFacts(
  worktrees: Iterable<
    Pick<Worktree, 'id' | 'repoId' | 'branch' | 'linkedPR' | 'suppressedGitHubPR'>
  >,
  repos: Iterable<Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'>>,
  prCache: PRCacheView
): Record<string, WorkspaceReviewFact> {
  const repoById = new Map([...repos].map((repo) => [repo.id, repo]))
  const facts: Record<string, WorkspaceReviewFact> = {}
  for (const worktree of worktrees) {
    const fact = readWorkspaceReviewFact(worktree, repoById.get(worktree.repoId), prCache)
    if (fact) {
      facts[worktree.id] = fact
    }
  }
  return facts
}

/** A paired server's rows against this desktop's own cache, under the server's host-scoped keys. */
export function buildPairedServerReviewFacts(
  servers: readonly { hostId: string; rows: readonly PairedServerWorkspaceRow[] }[],
  prCache: PRCacheView
): Record<string, WorkspaceReviewFact> {
  const facts: Record<string, WorkspaceReviewFact> = {}
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
        facts[row.worktreeId] = fact
      }
    }
  }
  return facts
}
