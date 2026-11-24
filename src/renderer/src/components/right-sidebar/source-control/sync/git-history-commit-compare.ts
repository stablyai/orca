import { translate } from '@/i18n/i18n'
import type { GitCommitCompareResult } from '../../../../../../shared/git/diff/git-diff-compare-types'

export type CommitCompareReads = {
  cache: Map<string, GitCommitCompareResult>
  pending: Map<string, Promise<GitCommitCompareResult>>
}

export function commitDiffErrorMessage(error?: unknown): string {
  return error instanceof Error
    ? error.message
    : translate(
        'auto.components.right.sidebar.SourceControl.8a5ba6a988',
        'Failed to load commit diff'
      )
}

/** Joins the commit's read in flight, or starts one; a ready result is cached for later reads. */
export function trackCommitCompare(
  reads: CommitCompareReads,
  commitId: string,
  dispatch: () => Promise<GitCommitCompareResult>
): Promise<GitCommitCompareResult> {
  // Reselecting a commit before its compare settles must not ask the owner again.
  const inFlight = reads.pending.get(commitId)
  if (inFlight) {
    return inFlight
  }
  const read = dispatch().then((result) => {
    if (result.summary.status !== 'ready') {
      throw new Error(result.summary.errorMessage ?? commitDiffErrorMessage())
    }
    reads.cache.set(commitId, result)
    return result
  })
  reads.pending.set(commitId, read)
  // A failed read is not kept, so Retry or a later selection reads again.
  const release = (): void => {
    reads.pending.delete(commitId)
  }
  void read.then(release, release)
  return read
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
