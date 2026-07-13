// Why: a dirty tab restored from a workspace session carries edits based on
// disk content that may have changed while the app was closed (an agent write,
// a sync tool). The in-memory changed-on-disk mark does not survive restarts,
// so without this scan a resumed autosave would silently overwrite that newer
// content (issue #7265 follow-up). The scan re-derives the conflict from
// ground truth: it reads each restored dirty tab's file and compares the disk
// signature against the persisted edit baseline. Autosave is hard-suspended
// for those tabs (pendingDiskBaselineVerification, set at hydration) until a
// verification resolves — otherwise the read would merely race the autosave
// timer and a slow remote read would lose.
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { canAutoSaveOpenFile } from './editor-autosave'
import { getDiskBaselineSignature } from './diff-content-signature'
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'

type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

// Why: SSH/runtime reads fail while the connection is still coming up after
// launch. Retry fast for the first minute, then keep probing slowly —
// giving up on a transport error would either strand the tab's autosave
// suspension or lift it unverified right as the transport comes back up.
// Only a definitive not-found (file deleted while the app was closed) ends
// the loop early; see probeFileMissing.
const VERIFY_RETRY_MS = 2_000
const VERIFY_SLOW_RETRY_MS = 15_000
const VERIFY_FAST_ATTEMPTS = 30
// Why: a session restored with many dirty tabs would otherwise fire one disk
// read per tab simultaneously — on SSH/remote runtimes that's N concurrent
// 15s-timeout RPCs competing with connection recovery at startup. Verifies
// beyond the cap queue and start as slots free up; none are dropped.
const MAX_CONCURRENT_VERIFY_READS = 3

export function attachRestoredTabConflictScan(store: AppStoreApi): () => void {
  // Why: dedupes queued + in-flight verifications; the store's pending flag is
  // the durable "needs verification" signal.
  const inFlightFileIds = new Set<string>()
  const attemptsByFileId = new Map<string, number>()
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()
  // Why: queue ids, not OpenFile snapshots. Ids are paths, so a snapshot can go
  // stale (close/reopen or save at the same path) while it waits for a slot;
  // the live file is re-read at dispatch instead.
  const verifyQueue: string[] = []
  let activeVerifyReads = 0
  let disposed = false

  // Why: distinguishes "file was deleted while the app was closed" (a
  // definitive not-found) from a transport still coming up. Only local/SSH
  // paths can be probed — for runtime-owned files window.api.fs would stat
  // the client-local path and misreport a remote file as gone.
  const probeFileMissing = async (file: OpenFile): Promise<boolean> => {
    const settings = settingsForRuntimeOwner(store.getState().settings, file.runtimeEnvironmentId)
    if (settings?.activeRuntimeEnvironmentId?.trim()) {
      return false
    }
    try {
      const exists = await globalThis.window?.api?.fs?.pathExists?.({
        filePath: file.filePath,
        connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined
      })
      return exists === false
    } catch {
      // Why: a failed probe can't disprove existence — keep retrying.
      return false
    }
  }

  const verify = async (file: OpenFile): Promise<void> => {
    // Why: OpenFile ids are file paths — a marker left behind by an early
    // exit would silently skip every future verification of a reopened
    // same-path tab. Only a scheduled retry may keep the marker set.
    let retryScheduled = false
    try {
      const state = store.getState()
      const result = await readRuntimeFileContent({
        settings: settingsForRuntimeOwner(state.settings, file.runtimeEnvironmentId),
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId,
        connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined
      })
      if (disposed) {
        return
      }
      const liveFile = store.getState().openFiles.find((f) => f.id === file.id)
      if (!liveFile) {
        return
      }
      // Why: verification resolved — lift the autosave suspension regardless
      // of outcome. If a save raced the read, the save already re-baselined
      // and cleared the flag itself; wasPending distinguishes that case.
      const wasPending = liveFile.pendingDiskBaselineVerification === true
      store.getState().clearPendingDiskBaselineVerification(file.id)
      if (
        !wasPending ||
        result.isBinary ||
        !liveFile.isDirty ||
        liveFile.externalMutation === 'changed'
      ) {
        return
      }
      if (getDiskBaselineSignature(result.content) !== file.lastKnownDiskSignature) {
        markFileChangedOnDisk(store.getState(), liveFile, {
          connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
          origin: 'restore'
        })
      }
    } catch {
      if (disposed) {
        return
      }
      if (await probeFileMissing(file)) {
        if (disposed) {
          return
        }
        // Why: a definitive not-found IS ground truth — there is no newer
        // disk content for a save to clobber, so verification is resolved.
        // Converge to the live delete affordance (tombstone mark) instead of
        // retrying forever with the tab's autosave silently suspended.
        const liveFile = store.getState().openFiles.find((f) => f.id === file.id)
        if (!liveFile) {
          return
        }
        const wasPending = liveFile.pendingDiskBaselineVerification === true
        store.getState().clearPendingDiskBaselineVerification(file.id)
        if (wasPending && liveFile.isDirty && liveFile.externalMutation !== 'changed') {
          store.getState().setExternalMutation(file.id, 'deleted')
        }
        return
      }
      if (disposed) {
        return
      }
      const attempts = (attemptsByFileId.get(file.id) ?? 0) + 1
      attemptsByFileId.set(file.id, attempts)
      retryScheduled = true
      const timer = setTimeout(
        () => {
          retryTimers.delete(timer)
          inFlightFileIds.delete(file.id)
          scan()
        },
        attempts < VERIFY_FAST_ATTEMPTS ? VERIFY_RETRY_MS : VERIFY_SLOW_RETRY_MS
      )
      retryTimers.add(timer)
    } finally {
      if (!retryScheduled) {
        inFlightFileIds.delete(file.id)
      }
    }
  }

  const pumpVerifyQueue = (): void => {
    while (!disposed && activeVerifyReads < MAX_CONCURRENT_VERIFY_READS && verifyQueue.length > 0) {
      const fileId = verifyQueue.shift()!
      // Why: re-read the live file when the slot opens. A queued id may now
      // resolve to a reopened or saved same-path tab, so re-validate it against
      // the current state before spending a disk read; skipping frees the dedupe
      // marker so a later scan can re-queue it if it needs verification again.
      const file = store.getState().openFiles.find((f) => f.id === fileId)
      if (
        !file ||
        !file.pendingDiskBaselineVerification ||
        !file.isDirty ||
        !file.lastKnownDiskSignature ||
        file.externalMutation === 'changed' ||
        !canAutoSaveOpenFile(file)
      ) {
        inFlightFileIds.delete(fileId)
        continue
      }
      activeVerifyReads += 1
      const onSettled = (): void => {
        activeVerifyReads -= 1
        pumpVerifyQueue()
      }
      // Why: verify() never rejects by design, but a rejection here must still
      // release the slot or the queue stalls permanently.
      void verify(file).then(onSettled, onSettled)
    }
  }

  const scan = (): void => {
    if (disposed) {
      return
    }
    for (const file of store.getState().openFiles) {
      if (
        !file.pendingDiskBaselineVerification ||
        !file.isDirty ||
        !file.lastKnownDiskSignature ||
        file.externalMutation === 'changed' ||
        !canAutoSaveOpenFile(file) ||
        inFlightFileIds.has(file.id)
      ) {
        continue
      }
      inFlightFileIds.add(file.id)
      verifyQueue.push(file.id)
    }
    pumpVerifyQueue()
  }

  let previousOpenFiles = store.getState().openFiles
  const unsubscribe = store.subscribe(() => {
    const nextOpenFiles = store.getState().openFiles
    if (nextOpenFiles === previousOpenFiles) {
      return
    }
    previousOpenFiles = nextOpenFiles
    scan()
  })
  scan()

  return () => {
    disposed = true
    unsubscribe()
    for (const timer of retryTimers) {
      clearTimeout(timer)
    }
    retryTimers.clear()
    verifyQueue.length = 0
  }
}
