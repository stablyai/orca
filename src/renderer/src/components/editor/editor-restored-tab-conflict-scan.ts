// Why: a restored dirty tab's changed-on-disk mark doesn't survive restarts (issue #7265), so re-derive the conflict from disk — else a resumed autosave silently overwrites newer content; autosave stays suspended (pendingDiskBaselineVerification) until verification resolves.
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

// Retry fast then slow: reads fail while SSH/runtime transport is still coming up; giving up would strand autosave suspension.
const VERIFY_RETRY_MS = 2_000
const VERIFY_SLOW_RETRY_MS = 15_000
const VERIFY_FAST_ATTEMPTS = 30
// Cap concurrent reads: many restored dirty tabs would otherwise fire N concurrent 15s RPCs competing with startup connection recovery.
const MAX_CONCURRENT_VERIFY_READS = 3

export function attachRestoredTabConflictScan(store: AppStoreApi): () => void {
  // Dedupes queued + in-flight verifications; the store's pending flag is the durable "needs verification" signal.
  const inFlightFileIds = new Set<string>()
  const attemptsByFileId = new Map<string, number>()
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()
  // Queue ids, not OpenFile snapshots: a snapshot can go stale (close/reopen or same-path save) while it waits for a slot.
  const verifyQueue: string[] = []
  let activeVerifyReads = 0
  let disposed = false

  // Only local/SSH paths can be probed: for runtime-owned files window.api.fs would stat the client path and misreport it as gone.
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
    // ids are file paths: a stray leftover marker would skip a reopened same-path tab, so only a scheduled retry keeps it set.
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
      // Verification resolved: lift autosave suspension regardless of outcome; wasPending flags a save that already re-baselined.
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
        // Definitive not-found = resolved: no newer disk content for a save to clobber, so mark deleted instead of retrying forever.
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
      // Re-read live file: a queued id may now be a reopened/saved same-path tab; re-validate before a disk read, and skipping frees the dedupe marker so a later scan can re-queue it.
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
      // verify() never rejects, but a stray rejection must still free the slot or the queue stalls.
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
