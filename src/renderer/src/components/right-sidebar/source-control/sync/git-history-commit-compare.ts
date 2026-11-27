import { translate } from '@/i18n/i18n'
import type { GitCommitCompareResult } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitHistoryItem } from '../../../../../../shared/git/history/git-history-types'

type PendingCommitCompare = { read: Promise<GitCommitCompareResult>; startedAt: number }

export type CommitCompareReads = {
  cache: Map<string, GitCommitCompareResult>
  pending: Map<string, PendingCommitCompare>
}

// The owner RPC gives up after 15s; a read older than that is presumed stuck and is not joined.
export const COMMIT_COMPARE_JOIN_WINDOW_MS = 15_000

export function commitDiffErrorMessage(error?: unknown): string {
  return error instanceof Error
    ? error.message
    : translate(
        'auto.components.right.sidebar.SourceControl.8a5ba6a988',
        'Failed to load commit diff'
      )
}

/**
 * Which compare a read answers: the commit and the parents its history page shows. A shallow
 * checkout's boundary commit shows none and compares against the empty tree; once the checkout
 * is deepened the same commit shows its parent, so an earlier read or result is not reused.
 */
export function commitCompareKey(item: GitHistoryItem): string {
  return JSON.stringify([item.id, item.parentIds])
}

/** Joins the compare's recent read in flight, or starts one; a ready result is cached for later reads. */
export function trackCommitCompare(
  reads: CommitCompareReads,
  compareKey: string,
  dispatch: () => Promise<GitCommitCompareResult>
): Promise<GitCommitCompareResult> {
  // Reselecting a commit before its compare settles must not ask the owner again,
  // unless that read has outlived the owner timeout and may never settle.
  const inFlight = reads.pending.get(compareKey)
  if (inFlight && Date.now() - inFlight.startedAt < COMMIT_COMPARE_JOIN_WINDOW_MS) {
    return inFlight.read
  }
  const read = dispatch().then((result) => {
    if (result.summary.status !== 'ready') {
      throw new Error(result.summary.errorMessage ?? commitDiffErrorMessage())
    }
    // A read replaced after the timeout must not overwrite its successor's result.
    if (reads.pending.get(compareKey)?.read === read || !reads.cache.has(compareKey)) {
      reads.cache.set(compareKey, result)
    }
    return result
  })
  reads.pending.set(compareKey, { read, startedAt: Date.now() })
  // A failed read is not kept, so Retry or a later selection reads again; a replaced read leaves its successor.
  const release = (): void => {
    if (reads.pending.get(compareKey)?.read === read) {
      reads.pending.delete(compareKey)
    }
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
