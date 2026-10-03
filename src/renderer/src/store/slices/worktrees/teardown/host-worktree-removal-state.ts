import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  isRecoverableRemoteRuntimeConnectionError,
  isRuntimeRpcQueueOverloadError,
  toRemoteRuntimeClientErrorLike
} from '../../../../../../shared/remote-runtime-client-error-classification'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'

export const UNFINISHED_WORKTREE_REMOVAL_ERROR = 'The delete did not finish. Try again.'

type RemovalRow = Pick<Worktree, 'id' | 'hostId' | 'removing' | 'removalError'>

function rowHostId(row: Pick<Worktree, 'hostId'>): ExecutionHostId {
  return row.hostId ?? LOCAL_EXECUTION_HOST_ID
}

/**
 * A delete request that failed in transport (a timeout or a dropped connection) says nothing about
 * the delete: the host may have accepted it and still be deleting. A queue overload never sent it.
 */
export function isWorktreeRemovalReplyLost(error: unknown): boolean {
  const reported = toRemoteRuntimeClientErrorLike(error)
  if (isRuntimeRpcQueueOverloadError(reported)) {
    return false
  }
  const message = reported.message.toLowerCase()
  return (
    isRecoverableRemoteRuntimeConnectionError(reported) ||
    message.includes('request timed out') ||
    message.includes('connection interrupted')
  )
}

const pendingJudgements = new Set<() => void>()

/**
 * Settles a delete whose reply was lost from the host's listing, as every other view does: the row
 * leaving means the delete finished, and the row listed without `removing` means it did not (with
 * the host's error when it lists one). When the listing cannot be read either, rejects with the
 * lost reply's error.
 */
function waitForHostWorktreeRemoval(args: {
  hostId: ExecutionHostId | undefined
  worktreeId: string
  readRows: () => readonly RemovalRow[]
  /** Re-reads the host's listing; true only when an authoritative listing was applied. */
  refresh: () => Promise<boolean>
  replyError: unknown
}): Promise<void> {
  const hostId = args.hostId ?? LOCAL_EXECUTION_HOST_ID
  return new Promise((resolve, reject) => {
    const judge = (): void => {
      const row = args
        .readRows()
        .find((candidate) => candidate.id === args.worktreeId && rowHostId(candidate) === hostId)
      if (row?.removing) {
        return
      }
      pendingJudgements.delete(judge)
      if (row) {
        reject(new Error(row.removalError ?? UNFINISHED_WORKTREE_REMOVAL_ERROR))
      } else {
        resolve()
      }
    }
    // Why judge only after a refresh: the rows held when the reply was lost can predate the host
    // accepting the delete, and would read as a delete that never started.
    const fail = (): void => reject(args.replyError)
    args.refresh().then((applied) => {
      if (!applied) {
        fail()
        return
      }
      pendingJudgements.add(judge)
      judge()
    }, fail)
  })
}

/** A lost reply for a delete of `worktreeId`, settled from its repo's listing on `hostId`. */
export function settleLostWorktreeRemovalReply(
  get: WorktreeSliceGet,
  args: { worktreeId: string; hostId: ExecutionHostId | undefined; replyError: unknown }
): Promise<void> {
  const repoId = getRepoIdFromWorktreeId(args.worktreeId)
  return waitForHostWorktreeRemoval({
    ...args,
    readRows: () => [
      ...(get().worktreesByRepo[repoId] ?? []),
      ...(get().detectedWorktreesByRepo[repoId]?.worktrees ?? [])
    ],
    refresh: () =>
      args.hostId
        ? get().fetchWorktrees(repoId, { executionHostId: args.hostId })
        : get().fetchWorktrees(repoId)
  })
}

/** Re-reads every delete waiting on the host's listing; call when listings change. */
export function settleHostWorktreeRemovals(): void {
  for (const judge of pendingJudgements) {
    judge()
  }
}

export function _resetHostWorktreeRemovalsForTests(): void {
  pendingJudgements.clear()
}
