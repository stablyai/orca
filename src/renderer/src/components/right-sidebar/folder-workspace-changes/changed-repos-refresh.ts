import type { GitStatusResult } from '../../../../../shared/git-status-types'
import type {
  FolderWorkspaceRepoCandidate,
  FolderWorkspaceRepoStatusOutcome
} from './changed-repo-model'

export type RunLimitedRepoStatusRefreshesArgs = {
  candidates: readonly FolderWorkspaceRepoCandidate[]
  concurrency?: number
  signal?: AbortSignal
  fetchStatus: (
    candidate: FolderWorkspaceRepoCandidate,
    signal?: AbortSignal
  ) => Promise<GitStatusResult>
  onOutcome?: (repoPath: string, outcome: FolderWorkspaceRepoStatusOutcome) => void
}

/** Fans `git status` out across sibling repos with bounded parallelism; an abort stops scheduling and drops late results. */
export async function runLimitedRepoStatusRefreshes({
  candidates,
  concurrency = 4,
  signal,
  fetchStatus,
  onOutcome
}: RunLimitedRepoStatusRefreshesArgs): Promise<Map<string, FolderWorkspaceRepoStatusOutcome>> {
  const outcomes = new Map<string, FolderWorkspaceRepoStatusOutcome>()
  const queue = [...candidates]
  const workerCount = Math.max(1, Math.min(concurrency, queue.length || 1))
  let cursor = 0

  const report = (repoPath: string, outcome: FolderWorkspaceRepoStatusOutcome): void => {
    if (signal?.aborted) {
      return
    }
    outcomes.set(repoPath, outcome)
    onOutcome?.(repoPath, outcome)
  }

  const runWorker = async (): Promise<void> => {
    while (cursor < queue.length && !signal?.aborted) {
      const candidate = queue[cursor]
      cursor += 1
      report(candidate.path, { kind: 'loading' })
      try {
        const status = await fetchStatus(candidate, signal)
        report(candidate.path, { kind: 'ready', status })
      } catch (error) {
        report(candidate.path, { kind: 'error', error })
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker))
  return outcomes
}
