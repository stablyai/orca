// "Move to this computer" for an Orca Cloud workspace: wake it if asleep, pack and download over
// orcad, create the local workspace through the ordinary create path (reusing the transferred
// branch), apply the uncommitted work and chats, then open it. The cloud workspace is left as is.
// Progress, success and failure render in the move's progress card (orca-cloud-move-store).
// Cancel is honoured while waking, packing and downloading; from the branch import on it isn't.
import { claimMoveRun, releaseMoveRun } from '@/lib/orca-cloud/orca-cloud-move-run'
import {
  createMovedWorktree,
  MoveCancelled,
  MoveFailed,
  NOT_RETRYABLE,
  releaseMoveHold,
  showCloudMoveDoneToast,
  STEP_OF_PHASE
} from '@/lib/orca-cloud/orca-cloud-move-run-parts'
import { cloudWorkspaceTarget } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { archiveTtlDays } from '@/lib/orca-cloud/archive-ttl'
import { DEFAULT_ARCHIVE_TTL_DAYS } from '@/components/orca-cloud/archive-snapshot-copy'
import { suspendEphemeralVmWorkspace } from '@/lib/workspace/activation/sidebar-worktree-activation'
import { holdMovingAsleep, releaseMovingAsleep } from '@/lib/orca-cloud/orca-cloud-move-asleep-hold'
import { setCloudWorkspacePending } from '@/lib/orca-cloud/orca-cloud-workspace-actions'
import {
  getCloudMoveState,
  noteCloudWorkspaceMoved,
  setCloudMoveState,
  type CloudMoveStep
} from '@/lib/orca-cloud/orca-cloud-move-store'
import type { CloudTransferPrepared } from '../../../shared/hosted-sandbox/cloud-transfer-api'

/** A move that hasn't settled by now is reported as failed (the pack or download stalled). */
export const MOVE_TIMEOUT_MS = 15 * 60_000

// The running move's Cancel; null when no move runs or Cancel is no longer offered.
let cancelRunning: (() => void) | null = null

/** Cancel on the progress card: stops the move and removes what it left on this computer. */
export function cancelOrcaCloudTransfer(): void {
  cancelRunning?.()
}

export async function runOrcaCloudTransferToLocal(
  workspaceId: string,
  name: string,
  options: {
    archiveAfter?: boolean
    onArchive?: (workspaceId: string, name: string) => void
  } = {}
): Promise<void> {
  const api = window.api?.orcaCloudWorkspace
  // One move at a time: a second click (or a retry racing the first) must not start another pack.
  if (!api?.prepareTransferToLocal) {
    return
  }
  const run = claimMoveRun()
  if (run === null) {
    return
  }
  // An archived workspace is unarchived to copy it and archived again after (main says so).
  let archiveAfter = options.archiveAfter ?? false
  const startedAt = Date.now()
  let step: CloudMoveStep = 'packing'
  let skipped: CloudMoveStep[] = ['waking']
  let bytes: number | null = null
  let totalBytes: number | null = null
  let timedOut = false
  let localWorktreeId: string | null = null
  let retry: { prepared: CloudTransferPrepared; worktreePath: string } | null = null
  let cancel: 'available' | 'cancelling' | null = 'available'
  let cancelled = false
  // Set while waking: the workspace was asleep, so a cancelled move puts it back to sleep.
  let wokeIt = false
  // Set when this move unarchived it: a cancelled move archives it again.
  let unarchivedIt = false
  // Set once this move archives the cloud workspace (archive-afterwards, or put back as it was).
  let archivedIt = false
  const archiveCloud = (): void => {
    archivedIt = true
    options.onArchive?.(workspaceId, name)
  }
  const isMinimized = (): boolean => {
    const current = getCloudMoveState()
    return current.stage !== 'closed' && current.stage !== 'confirm' && current.minimized
  }
  const throwIfCancelled = (): void => {
    if (cancelled) {
      throw new MoveCancelled()
    }
  }
  const publish = (): void => {
    if (timedOut) {
      return
    }
    const previous = getCloudMoveState()
    setCloudMoveState({
      stage: 'running',
      workspaceId,
      name,
      step,
      skipped,
      startedAt,
      bytes,
      totalBytes,
      archiveAfter,
      cancel,
      minimized: previous.stage === 'running' ? previous.minimized : false
    })
  }
  /** No more Cancel from here (the branch import began, or the local workspace is next). */
  const closeCancel = (): void => {
    if (cancel === 'available') {
      cancel = null
      cancelRunning = null
    }
  }
  cancelRunning = () => {
    if (cancel !== 'available') {
      return
    }
    cancel = 'cancelling'
    cancelled = true
    publish()
    // Main stops a pack or download in flight and deletes its files; while waking there is none
    // yet, and the run stops when the wake returns. False: the import already began, carry on.
    void api.cancelTransferToLocal?.({ workspaceId }).then(
      (honoured) => {
        if (!honoured && cancel === 'cancelling') {
          cancelled = false
          cancel = null
          cancelRunning = null
          publish()
        }
      },
      () => undefined
    )
  }
  const timeout = setTimeout(() => {
    // Stop waiting, and stop main too while it still packs or downloads. Retry waits until this
    // run has settled (main refuses a second prepare meanwhile); a late success still lands as a
    // notice (the workspace really is here).
    timedOut = true
    void api.cancelTransferToLocal?.({ workspaceId }).catch(() => undefined)
    setCloudMoveState({
      stage: 'failed',
      workspaceId,
      name,
      step,
      timedOut: true,
      reason: null,
      retryable: false,
      restored: null,
      localWorktreeId,
      archiveAfter,
      minimized: isMinimized()
    })
  }, MOVE_TIMEOUT_MS)
  const live = (): boolean => !timedOut && getCloudMoveState().stage === 'running'
  const dispose = api.onTransferProgress((event) => {
    const next = event.workspaceId === workspaceId ? STEP_OF_PHASE[event.phase] : undefined
    if (!next) {
      return
    }
    step = next
    bytes = event.bytes ?? bytes
    totalBytes = event.totalBytes ?? totalBytes
    if (event.phase === 'importing') {
      closeCancel()
    }
    if (step !== 'waking') {
      // Packing captures the files: from here, changes made in the cloud workspace aren't included.
      setCloudWorkspacePending(workspaceId, 'move')
    }
    publish()
  })
  try {
    publish()
    let prepared = await api.prepareTransferToLocal({ workspaceId })
    throwIfCancelled()
    if (!prepared.ok && (prepared.code === 'asleep' || prepared.code === 'archived')) {
      step = 'waking'
      skipped = []
      wokeIt = true
      // Its page keeps the asleep view, and its lifecycle actions wait, from the wake on.
      holdMovingAsleep(workspaceId)
      setCloudWorkspacePending(workspaceId, 'move')
      publish()
      if (prepared.code === 'archived') {
        // Same disk back from the archive snapshot; only a running sandbox can pack it.
        const unarchived = await api.unarchive(cloudWorkspaceTarget(workspaceId))
        if (!unarchived.ok) {
          throw new MoveFailed('wake_failed', unarchived.userMessage ?? unarchived.message)
        }
        archiveAfter = true
        unarchivedIt = true
      }
      const woke = await window.api.ephemeralVm.resumeWorkspace({ workspaceId })
      throwIfCancelled()
      if (!woke.ok) {
        // Named while the step still says Waking (not as a packing failure).
        throw new MoveFailed('wake_failed', woke.error)
      }
      step = 'packing'
      setCloudWorkspacePending(workspaceId, 'move')
      publish()
      prepared = await api.prepareTransferToLocal({ workspaceId })
    }
    if (!prepared.ok && prepared.code === 'cancelled') {
      throw new MoveCancelled()
    }
    if (!prepared.ok) {
      throw new MoveFailed(prepared.code, prepared.message)
    }
    // A Cancel that raced the end of the download: the branch is already here, so the move goes on.
    cancelled = false
    cancel = null
    cancelRunning = null
    const { transferId, repoId, branch, baseBranch } = prepared.value
    step = 'creating'
    publish()
    const worktree = await createMovedWorktree(repoId, branch, baseBranch)
    localWorktreeId = worktree.id
    retry = { prepared: prepared.value, worktreePath: worktree.path }
    step = 'applying'
    publish()
    const finished = await api.finishTransferToLocal({ transferId, worktreePath: worktree.path })
    if (!finished.ok) {
      throw new Error(finished.message)
    }
    if (timedOut) {
      noteCloudWorkspaceMoved(workspaceId, Date.now(), worktree.id)
      // The "taking too long" card is moot (and its Retry would move it twice): the notice replaces it.
      const stale = getCloudMoveState()
      if (stale.stage === 'failed' && stale.workspaceId === workspaceId) {
        setCloudMoveState({ stage: 'closed' })
      }
      showCloudMoveDoneToast(worktree, name, false, archiveTtlDays() ?? DEFAULT_ARCHIVE_TTL_DAYS)
      return
    }
    noteCloudWorkspaceMoved(workspaceId, Date.now(), worktree.id)
    // Never archive while something is left to apply: the cloud copy is the other place it lives.
    const archiveNow = archiveAfter && !finished.value.leftoverPatchDir
    if (!finished.value.leftoverPatchDir) {
      // Landed in full: the background-create toast, not a card.
      setCloudMoveState({ stage: 'closed' })
      releaseMoveHold(workspaceId)
      if (archiveNow) {
        archiveCloud()
      }
      showCloudMoveDoneToast(
        worktree,
        name,
        archiveNow,
        archiveTtlDays() ?? DEFAULT_ARCHIVE_TTL_DAYS
      )
      return
    }
    // Partly applied: the card stays, with what was saved and Reapply.
    setCloudMoveState({
      stage: 'done',
      workspaceId,
      name,
      localWorktreeId: worktree.id,
      prepared: prepared.value,
      finished: finished.value,
      elapsedMs: Date.now() - startedAt,
      archivedAfter: archiveNow,
      archiveAfter,
      // The result shows itself (it never takes focus or switches workspace); Open goes there.
      minimized: false
    })
    releaseMoveHold(workspaceId)
    if (archiveNow) {
      archiveCloud()
    }
  } catch (error) {
    if (error instanceof MoveCancelled || (cancelled && !timedOut)) {
      // Main already removed what the pack and download left here. A workspace this move
      // unarchived is archived again, one it woke goes back to sleep: as it was.
      if (unarchivedIt) {
        archiveCloud()
      }
      if (live()) {
        setCloudMoveState({ stage: 'closed' })
      }
      return
    }
    // Details go to the log; the card names the reason when it is one the user can act on.
    console.error('[orca-cloud] move to this computer failed', error)
    const reason = error instanceof MoveFailed ? error.code : null
    // Nothing landed here: a workspace this move unarchived goes back to the archive, as promised.
    const restore = unarchivedIt && localWorktreeId === null && !timedOut
    if (restore) {
      archiveCloud()
    }
    if (live()) {
      setCloudMoveState({
        stage: 'failed',
        workspaceId,
        name,
        step,
        timedOut: false,
        reason,
        retryable: !NOT_RETRYABLE.has(reason ?? ''),
        restored: restore ? 'archived' : null,
        localWorktreeId,
        retry,
        archiveAfter: restore ? false : archiveAfter,
        minimized: false
      })
    }
  } finally {
    clearTimeout(timeout)
    releaseMoveRun(run)
    // A timed-out run has now settled in main: Retry can start a fresh one.
    const current = getCloudMoveState()
    if (timedOut && current.stage === 'failed' && current.workspaceId === workspaceId) {
      setCloudMoveState({ ...current, retryable: true })
    }
    releaseMoveHold(workspaceId)
    cancelRunning = null
    dispose()
    // A workspace this move woke goes back to sleep however it ended (unless it is archived now);
    // its page left the asleep view only once that is done.
    void (wokeIt && !archivedIt ? suspendEphemeralVmWorkspace(workspaceId) : Promise.resolve())
      .catch(() => undefined)
      .finally(() => releaseMovingAsleep(workspaceId))
  }
}
