// Why: a restored dirty tab's changed-on-disk mark doesn't survive restarts (issue #7265), so re-derive the conflict from disk — else a resumed autosave silently overwrites newer content; autosave stays suspended (pendingDiskBaselineVerification) until verification resolves.
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import {
  getRuntimeTargetForFileOwner,
  requireRuntimeTargetForFileOwner
} from '@/lib/file-owner-runtime-target'
import { canAutoSaveOpenFile } from './editor-autosave'
import { getDiskBaselineSignature } from './diff-content-signature'
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'
import { runtimePathsExist } from '@/runtime/runtime-path-existence-batch'

type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

// Retry fast then slow: reads fail while SSH/runtime transport is still coming up; giving up would strand autosave suspension.
const VERIFY_RETRY_MS = 2_000
const VERIFY_SLOW_RETRY_MS = 15_000
const VERIFY_FAST_ATTEMPTS = 30
// Cap concurrent reads: many restored dirty tabs would otherwise fire N concurrent 15s RPCs competing with startup connection recovery.
const MAX_CONCURRENT_VERIFY_READS = 3
// Why: an unreachable host must not suspend autosave forever; give up with the conflict banner instead.
export const MAX_VERIFY_ATTEMPTS = VERIFY_FAST_ATTEMPTS + 10

// Why: a disk check requested while one is in flight must not be answered by the older read.
// A global sequence, so dropping a closed tab's entry can't let a reopened tab's request reuse an old read's number.
const verifyRequestGenerationByFileId = new Map<string, number>()
let verifyRequestGenerationSeq = 0

/** Asks for a fresh disk check of a tab; a read already in flight is followed by one more. */
export function requestRestoredTabReverification(fileId: string): void {
  verifyRequestGenerationSeq += 1
  verifyRequestGenerationByFileId.set(fileId, verifyRequestGenerationSeq)
}

export function getRestoredTabReverificationRequestCountForTest(): number {
  return verifyRequestGenerationByFileId.size
}

function forgetClosedTabReverificationRequests(openFiles: readonly OpenFile[]): void {
  if (verifyRequestGenerationByFileId.size === 0) {
    return
  }
  const openIds = new Set(openFiles.map((file) => file.id))
  for (const fileId of verifyRequestGenerationByFileId.keys()) {
    if (!openIds.has(fileId)) {
      verifyRequestGenerationByFileId.delete(fileId)
    }
  }
}

function verifyRequestGeneration(fileId: string): number {
  return verifyRequestGenerationByFileId.get(fileId) ?? 0
}

export function attachRestoredTabConflictScan(store: AppStoreApi): () => void {
  // Dedupes queued + in-flight verifications; the store's pending flag is the durable "needs verification" signal.
  const inFlightFileIds = new Set<string>()
  const attemptsByFileId = new Map<string, number>()
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()
  // Queue ids, not OpenFile snapshots: a snapshot can go stale (close/reopen or same-path save) while it waits for a slot.
  const verifyQueue: string[] = []
  let activeVerifyReads = 0
  let disposed = false

  const getFileConnectionId = (file: OpenFile): string | undefined => {
    const connectionId = getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined
    const externalSshTargetId = file.externalSshTargetId?.trim()
    if (externalSshTargetId && connectionId !== externalSshTargetId) {
      throw new Error('External SSH file owner changed')
    }
    return connectionId
  }

  // Only local/SSH paths can be probed: for runtime-owned files window.api.fs would stat the client path and misreport it as gone.
  const probeFileMissing = async (file: OpenFile): Promise<boolean> => {
    const owner = getRuntimeTargetForFileOwner(
      store.getState(),
      file.worktreeId,
      file.runtimeEnvironmentId
    )
    // Why `!owner`: with no single owner, nothing can prove the file gone.
    if (!owner) {
      return false
    }
    if (owner.kind !== 'local') {
      try {
        const [row] = await runtimePathsExist(
          {
            target: owner,
            worktreeId: file.worktreeId,
            // Why: tabs keep their root implicitly as filePath minus relativePath.
            worktreePath: file.filePath.slice(
              0,
              Math.max(0, file.filePath.length - file.relativePath.length - 1)
            ),
            connectionId: getFileConnectionId(file)
          },
          [file.filePath],
          undefined,
          // Why: only a per-path ENOENT on the owning host proves absence.
          { codedAbsenceOnly: true }
        )
        return row !== undefined && 'exists' in row && !row.exists
      } catch {
        return false
      }
    }
    try {
      const connectionId = getFileConnectionId(file)
      const access = connectionId ? undefined : editorTabFileAccess(store.getState(), file)
      const exists = await globalThis.window?.api?.fs?.pathExists?.({
        filePath: file.filePath,
        connectionId,
        ...(access ? { access } : {})
      })
      return exists === false
    } catch {
      // Why: a failed probe can't disprove existence — keep retrying.
      return false
    }
  }

  // Why: a newer check was requested mid-read; this answer may predate it, so keep the flag and read once more.
  const rereadIfSuperseded = (fileId: string, requestGeneration: number): boolean => {
    if (verifyRequestGeneration(fileId) === requestGeneration) {
      return false
    }
    queueMicrotask(() => {
      inFlightFileIds.delete(fileId)
      scan()
    })
    return true
  }

  const verify = async (file: OpenFile): Promise<void> => {
    // ids are file paths: a stray leftover marker would skip a reopened same-path tab, so only a scheduled retry keeps it set.
    let retryScheduled = false
    const requestGeneration = verifyRequestGeneration(file.id)
    try {
      const state = store.getState()
      const result = await readRuntimeFileContent({
        target: requireRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId),
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId,
        connectionId: getFileConnectionId(file),
        expectedExternalSshTargetId: file.externalSshTargetId,
        access: editorTabFileAccess(state, file)
      })
      if (disposed) {
        return
      }
      const liveFile = store.getState().openFiles.find((f) => f.id === file.id)
      if (!liveFile) {
        return
      }
      if (rereadIfSuperseded(file.id, requestGeneration)) {
        retryScheduled = true
        return
      }
      attemptsByFileId.delete(file.id)
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
        if (rereadIfSuperseded(file.id, requestGeneration)) {
          retryScheduled = true
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
      if (attempts >= MAX_VERIFY_ATTEMPTS) {
        giveUp(file)
        return
      }
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

  // Why: still unverifiable after every retry; resume nothing silently — the banner makes the user choose.
  const giveUp = (file: OpenFile): void => {
    attemptsByFileId.delete(file.id)
    const liveFile = store.getState().openFiles.find((f) => f.id === file.id)
    if (!liveFile?.pendingDiskBaselineVerification) {
      return
    }
    store.getState().clearPendingDiskBaselineVerification(file.id)
    if (liveFile.isDirty && liveFile.externalMutation !== 'changed') {
      markFileChangedOnDisk(store.getState(), liveFile, {
        connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
        origin: 'restore'
      })
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
    forgetClosedTabReverificationRequests(nextOpenFiles)
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
