import type {
  GitHubOwnerRepo,
  RelandedPullRequestSummary
} from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import type { AppState } from '../types'
import { getGitHubSourceTarget, getGitHubWorkItemRequestContext } from './work-item-routing'

// Why: a closed PR's re-landing rarely changes, so one lookup per half hour is plenty.
const RELANDINGS_TTL_MS = 30 * 60_000
const relandings = new Map<string, { fetchedAt: number; data: RelandedPullRequestSummary[] }>()
const inflight = new Map<string, Promise<RelandedPullRequestSummary[]>>()

function relandingsKey(repo: Pick<Repo, 'id'>, prNumber: number, prRepo: GitHubOwnerRepo | null) {
  return `${repo.id}::${prRepo ? `${prRepo.host ?? ''}/${prRepo.owner}/${prRepo.repo}` : ''}#${prNumber}`
}

/** Merged PRs that carried a closed PR's work; empty on failure, including older remote hosts. */
export function fetchPRRelandings(
  state: AppState,
  repo: Repo,
  prNumber: number,
  prRepo: GitHubOwnerRepo | null
): Promise<RelandedPullRequestSummary[]> {
  const key = relandingsKey(repo, prNumber, prRepo)
  const cached = relandings.get(key)
  if (cached && Date.now() - cached.fetchedAt < RELANDINGS_TTL_MS) {
    return Promise.resolve(cached.data)
  }
  const pending = inflight.get(key)
  if (pending) {
    return pending
  }
  const request = (async () => {
    try {
      const context = getGitHubWorkItemRequestContext(
        state,
        getGitHubSourceTarget(state, repo),
        repo.id,
        repo.path
      )
      const data =
        context.target.kind === 'environment'
          ? await callRuntimeRpc<RelandedPullRequestSummary[]>(
              { kind: 'environment', environmentId: context.target.environmentId },
              'github.prRelandings',
              { repo: context.target.runtimeRepoId, prNumber, prRepo },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.prRelandings({
              repoPath: repo.path,
              repoId: repo.id,
              prNumber,
              prRepo
            })
      relandings.set(key, { fetchedAt: Date.now(), data })
      return data
    } catch {
      return []
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, request)
  return request
}
