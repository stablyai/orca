// Why: a restored dirty tab's changed-on-disk mark doesn't survive restarts (issue #7265), so re-derive it from disk to show the banner early; the guarded save is what keeps autosave off newer content.
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
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'
import { runtimePathsExist } from '@/runtime/runtime-path-existence-batch'
import { getRecentSelfWrite } from './editor-self-write-registry'

type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

// Retry fast then slow: reads fail while SSH/runtime transport is still coming up.
const VERIFY_RETRY_MS = 2_000
const VERIFY_SLOW_RETRY_MS = 15_000
const VERIFY_FAST_ATTEMPTS = 30
// Cap concurrent reads: many restored dirty tabs would otherwise fire N concurrent 15s RPCs competing with startup connection recovery.
const MAX_CONCURRENT_VERIFY_READS = 3
export const MAX_VERIFY_ATTEMPTS = VERIFY_FAST_ATTEMPTS + 10

function needsDiskCheck(file: OpenFile): boolean {
  return (
    file.isDirty &&
    file.lastKnownDiskSignature !== undefined &&
    file.externalMutation !== 'changed' &&
    canAutoSaveOpenFile(file)
  )
}

export function attachRestoredTabConflictScan(store: AppStoreApi): () => void {
  // Why: only a tab that arrives dirty (a restore, or a dirty tab's rekey) is checked; edits made here start in sync.
  const seenFileIds = new Set<string>()
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

  // Why: a save (or reload) since the read re-baselined the tab, so the read proves nothing about it.
  const unchangedSinceRead = (file: OpenFile): OpenFile | null => {
    const liveFile = store.getState().openFiles.find((f) => f.id === file.id)
    return liveFile &&
      needsDiskCheck(liveFile) &&
      liveFile.lastKnownDiskSignature === file.lastKnownDiskSignature
      ? liveFile
      : null
  }

  const verify = async (file: OpenFile): Promise<void> => {
    // ids are file paths: a stray leftover marker would skip a reopened same-path tab, so only a scheduled retry keeps it set.
    let retryScheduled = false
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
      attemptsByFileId.delete(file.id)
      const liveFile = disposed ? null : unchangedSinceRead(file)
      if (
        !liveFile ||
        result.isBinary ||
        getDiskBaselineSignature(result.content) === file.lastKnownDiskSignature ||
        // Why: disk already holds the draft, so the next save goes through clean.
        result.content === store.getState().editorDrafts[file.id] ||
        // Why: the tab's own save can land before it rebaselines.
        getRecentSelfWrite(file.filePath, file.runtimeEnvironmentId)?.content === result.content
      ) {
        return
      }
      markFileChangedOnDisk(store.getState(), liveFile, {
        connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
        origin: 'restore'
      })
    } catch {
      if (disposed) {
        return
      }
      if (await probeFileMissing(file)) {
        attemptsByFileId.delete(file.id)
        const liveFile = disposed ? null : unchangedSinceRead(file)
        if (liveFile && liveFile.externalMutation !== 'deleted') {
          store.getState().setExternalMutation(file.id, 'deleted')
        }
        return
      }
      if (disposed) {
        return
      }
      const attempts = (attemptsByFileId.get(file.id) ?? 0) + 1
      attemptsByFileId.set(file.id, attempts)
      // Why stop silently: the banner is only early warning; the guarded save still refuses newer disk.
      if (attempts >= MAX_VERIFY_ATTEMPTS) {
        attemptsByFileId.delete(file.id)
        return
      }
      retryScheduled = true
      const timer = setTimeout(
        () => {
          retryTimers.delete(timer)
          verifyQueue.push(file.id)
          pumpVerifyQueue()
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
      // Re-read live file: a queued id may now be a reopened/saved same-path tab; skipping frees the dedupe marker.
      const file = store.getState().openFiles.find((f) => f.id === fileId)
      if (!file || !needsDiskCheck(file)) {
        inFlightFileIds.delete(fileId)
        attemptsByFileId.delete(fileId)
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
    const openFiles = store.getState().openFiles
    const openIds = new Set(openFiles.map((file) => file.id))
    for (const fileId of seenFileIds) {
      if (!openIds.has(fileId)) {
        seenFileIds.delete(fileId)
      }
    }
    for (const file of openFiles) {
      if (seenFileIds.has(file.id)) {
        continue
      }
      seenFileIds.add(file.id)
      if (needsDiskCheck(file) && !inFlightFileIds.has(file.id)) {
        inFlightFileIds.add(file.id)
        verifyQueue.push(file.id)
      }
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
