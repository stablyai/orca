import { translate } from '@/i18n/i18n'
import type { GitCommitCompareResult } from '../../../../../../shared/git/diff/git-diff-compare-types'

type PendingCommitCompare = { completion: PromiseWithResolvers<GitCommitCompareResult> }

export type CommitCompareReads = {
  cache: Map<string, GitCommitCompareResult>
  pending: Map<string, PendingCommitCompare>
}

export function commitDiffErrorMessage(error?: unknown): string {
  return error instanceof Error
    ? error.message
    : translate(
        'auto.components.right.sidebar.SourceControl.8a5ba6a988',
        'Failed to load commit diff'
      )
}

export function trackCommitCompare(
  reads: CommitCompareReads,
  commitId: string,
  request: Promise<GitCommitCompareResult>
): Promise<GitCommitCompareResult> {
  // When the same commit is read again, existing callers follow the newer reply.
  const completion =
    reads.pending.get(commitId)?.completion ?? Promise.withResolvers<GitCommitCompareResult>()
  const pending = { completion }
  reads.pending.set(commitId, pending)
  const settle = (result: GitCommitCompareResult | null, error?: unknown): void => {
    if (reads.pending.get(commitId) !== pending) {
      return
    }
    reads.pending.delete(commitId)
    if (result?.summary.status === 'ready') {
      reads.cache.set(commitId, result)
      completion.resolve(result)
    } else {
      completion.reject(
        error ?? new Error(result?.summary.errorMessage ?? commitDiffErrorMessage())
      )
    }
  }
  void request.then(
    (result) => settle(result),
    (error: unknown) => settle(null, error)
  )
  return completion.promise
}

// Latest Open diff per owner and commit across mounts, so a reopened view's open is not overwritten by an older one.
const latestCommitDiffOpens = new Map<string, object>()

/** Runs one Open diff; only the newest open for `openKey` that its caller still wants reaches a callback. */
export async function runLatestCommitDiffOpen<T>(
  openKey: string,
  load: () => Promise<T | null>,
  stillWanted: () => boolean,
  onReady: (value: T) => void,
  onError: (error: unknown) => void
): Promise<void> {
  const open = {}
  latestCommitDiffOpens.set(openKey, open)
  const current = (): boolean => latestCommitDiffOpens.get(openKey) === open && stillWanted()
  try {
    const value = await load()
    if (value && current()) {
      onReady(value)
    }
  } catch (error) {
    if (current()) {
      onError(error)
    }
  } finally {
    if (latestCommitDiffOpens.get(openKey) === open) {
      latestCommitDiffOpens.delete(openKey)
    }
  }
}
