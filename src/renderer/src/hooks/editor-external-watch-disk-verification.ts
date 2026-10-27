import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { joinPath } from '@/lib/path'
import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange
} from '@/components/editor/editor-autosave'
import { markFileChangedOnDisk } from '@/components/editor/editor-changed-on-disk-mark'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import {
  clearSelfWrite,
  getRecentSelfWrite,
  type RecentSelfWrite
} from '@/components/editor/editor-self-write-registry'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'

export type EditorExternalWatchNotification = {
  worktreeId: string
  worktreePath: string
  relativePath: string
  runtimeEnvironmentId: string | null
  allowLocalWindowsWslAliases?: true
  indexedOpenFiles?: {
    matches: (openFiles: OpenFile[]) => OpenFile[]
  }
}

// Coalesce atomic-write reload bursts per owner/path to prevent EditorPanel fan-out (#826); never postpone an armed dispatch under sustained writes.
const EXTERNAL_RELOAD_DEBOUNCE_MS = 75
const pendingExternalReloads = new Map<string, EditorExternalWatchNotification>()

export function scheduleDebouncedEditorExternalReload(
  notification: EditorExternalWatchNotification
): void {
  const key = `${notification.worktreeId}::${notification.runtimeEnvironmentId ?? 'client'}::${notification.relativePath}`
  const armed = pendingExternalReloads.has(key)
  pendingExternalReloads.set(key, notification)
  if (armed) {
    return
  }
  globalThis.setTimeout(() => {
    const latest = pendingExternalReloads.get(key)
    pendingExternalReloads.delete(key)
    if (latest) {
      notifyEditorExternalFileChange(latest)
    }
  }, EXTERNAL_RELOAD_DEBOUNCE_MS)
}

type EchoVerificationRead = ReturnType<typeof readRuntimeFileContent>
type EchoVerificationSlot = {
  current: EchoVerificationRead
  /** Payloads in the task that issued `current` were emitted before the read reached disk. */
  joinable: boolean
  next: EchoVerificationRead | null
}
const echoVerificationReads = new Map<string, EchoVerificationSlot>()

function beginEchoVerificationRead(
  key: string,
  read: () => EchoVerificationRead
): EchoVerificationRead {
  const current = read()
  const slot: EchoVerificationSlot = { current, joinable: true, next: null }
  echoVerificationReads.set(key, slot)
  queueMicrotask(() => {
    slot.joinable = false
  })
  const release = (): void => {
    if (echoVerificationReads.get(key) === slot && !slot.next) {
      echoVerificationReads.delete(key)
    }
  }
  current.then(release, release)
  return current
}

// Share burst echo reads, but queue one fresh read for later-task events that the in-flight disk snapshot may have missed.
function readFileForEchoVerification(args: {
  runtimeEnvironmentId: string | null | undefined
  filePath: string
  relativePath: string
  worktreeId: string | null | undefined
  connectionId: string | undefined
  expectedExternalSshTargetId?: string
}): EchoVerificationRead {
  const key = [
    args.runtimeEnvironmentId ?? '',
    args.connectionId ?? '',
    args.expectedExternalSshTargetId ?? '',
    args.filePath
  ].join('::')
  const read = (): EchoVerificationRead =>
    readRuntimeFileContent({
      target: runtimeTargetForOwnerEnvironment(args.runtimeEnvironmentId ?? null),
      filePath: args.filePath,
      relativePath: args.relativePath,
      worktreeId: args.worktreeId ?? undefined,
      connectionId: args.connectionId,
      expectedExternalSshTargetId: args.expectedExternalSshTargetId
    })
  const slot = echoVerificationReads.get(key)
  if (!slot) {
    return beginEchoVerificationRead(key, read)
  }
  if (slot.joinable) {
    return slot.current
  }
  slot.next ??= slot.current.then(
    () => beginEchoVerificationRead(key, read),
    () => beginEchoVerificationRead(key, read)
  )
  return slot.next
}

function markTabsChangedOnDisk(fileIds: string[], connectionId: string | undefined): void {
  const state = useAppStore.getState()
  for (const fileId of fileIds) {
    const file = state.openFiles.find((candidate) => candidate.id === fileId)
    // Async echo verification may outlive tab close; mark only still-open files.
    if (file) {
      markFileChangedOnDisk(state, file, { connectionId, origin: 'live' })
    }
  }
}

export function scheduleEditorChangedOnDiskMark(
  target: EditorExternalWatchTarget,
  notification: EditorExternalWatchNotification,
  fileIds: string[]
): void {
  if (fileIds.length === 0) {
    return
  }
  const absolutePath = joinPath(notification.worktreePath, notification.relativePath)
  const recentSelfWrite = getRecentSelfWrite(absolutePath, target.runtimeEnvironmentId)
  // Verify disk differs from the last save before labeling its watcher echo an external change.
  if (!recentSelfWrite || recentSelfWrite.content === null) {
    markTabsChangedOnDisk(fileIds, target.connectionId)
    return
  }
  void readFileForEchoVerification({
    runtimeEnvironmentId: target.runtimeEnvironmentId,
    filePath: absolutePath,
    relativePath: notification.relativePath,
    worktreeId: notification.worktreeId,
    connectionId: target.connectionId
  })
    .then((result) => {
      if (result.isBinary || result.content !== recentSelfWrite.content) {
        markTabsChangedOnDisk(fileIds, target.connectionId)
      }
    })
    .catch(() => {
      // Unreadable disk cannot disprove conflict; keep it visible instead of risking silent overwrite.
      markTabsChangedOnDisk(fileIds, target.connectionId)
    })
}

// Per-file generation so a newer echo-verify read supersedes an older one — an overlapping read can't apply a stale verdict.
const liveMoveVerifyGeneration = new Map<string, number>()
let liveMoveVerifyCounter = 0

type LiveMoveVerifyCandidate = {
  fileId: string
  baseline: string | undefined
  generation: number
  /** The move that installed the provenance; a newer move re-homing the tab supersedes this verification, even across a rekey. */
  operationId?: string
}

// Fails closed: `false` (anything but a proven match) surfaces the conflict; `null` (unread, on a resync) proves nothing.
function resolveLiveMoveVerification(
  candidate: LiveMoveVerifyCandidate,
  matchesDisk: boolean | null,
  connectionId: string | undefined,
  consumeProvenance: boolean
): void {
  const { fileId, baseline, generation, operationId } = candidate
  if (liveMoveVerifyGeneration.get(fileId) !== generation) {
    return
  }
  liveMoveVerifyGeneration.delete(fileId)
  const state = useAppStore.getState()
  const file = state.openFiles.find((candidateFile) => candidateFile.id === fileId)
  if (
    !file ||
    !file.isDirty ||
    file.externalMutation === 'changed' ||
    file.lastKnownDiskSignature !== baseline ||
    (operationId !== undefined && file.pendingSelfMoveEcho?.operationId !== operationId)
  ) {
    return
  }
  // Why: proactive post-commit verification leaves provenance for a later destination watcher event; a watcher-driven check consumes it.
  if (consumeProvenance) {
    state.clearSelfMoveEcho(fileId)
  }
  if (matchesDisk === false) {
    markFileChangedOnDisk(state, file, { connectionId, origin: 'live' })
  }
}

/** Verifies destination echoes latched before a completed editor path rekey. */
export function verifyLatchedEditorMoveDestinations(
  worktreePath: string,
  connectionId: string | undefined,
  fileIds: readonly string[]
): void {
  const state = useAppStore.getState()
  const gated = fileIds.filter(
    (id) => state.openFiles.find((file) => file.id === id)?.pendingSelfMoveEcho
  )
  if (gated.length === 0) {
    return
  }
  scheduleEditorSelfMoveEchoVerification(
    { worktreeId: '', worktreePath, connectionId, runtimeEnvironmentId: null },
    gated,
    false
  )
}

/** `resync`: a watch reconnect check, where a failed read leaves the tab to its guarded save. */
export function scheduleEditorSelfMoveEchoVerification(
  target: EditorExternalWatchTarget,
  fileIds: string[],
  consumeProvenance: boolean,
  resync = false
): void {
  if (fileIds.length === 0) {
    return
  }
  const state = useAppStore.getState()
  for (const fileId of fileIds) {
    const file = state.openFiles.find((candidate) => candidate.id === fileId)
    if (!file || !file.isDirty || file.externalMutation === 'changed') {
      continue
    }
    const generation = ++liveMoveVerifyCounter
    liveMoveVerifyGeneration.set(fileId, generation)
    const candidate: LiveMoveVerifyCandidate = {
      fileId,
      baseline: file.lastKnownDiskSignature,
      generation,
      operationId: file.pendingSelfMoveEcho?.operationId
    }
    // Cross-worktree tabs must read their own absolute paths, not paths joined under the initiating workspace.
    void readFileForEchoVerification({
      runtimeEnvironmentId: file.runtimeEnvironmentId?.trim() || target.runtimeEnvironmentId,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      connectionId: target.connectionId,
      expectedExternalSshTargetId: file.externalSshTargetId
    })
      .then((result) => {
        const matchesDisk =
          !result.isBinary &&
          ((candidate.baseline !== undefined &&
            getDiskBaselineSignature(result.content) === candidate.baseline) ||
            // Why: the tab's own save can land before it rebaselines; that is not an external change.
            getRecentSelfWrite(file.filePath, file.runtimeEnvironmentId)?.content ===
              result.content)
        resolveLiveMoveVerification(candidate, matchesDisk, target.connectionId, consumeProvenance)
      })
      .catch(() =>
        resolveLiveMoveVerification(
          candidate,
          resync ? null : false,
          target.connectionId,
          consumeProvenance
        )
      )
  }
}

export function scheduleSelfWriteAwareEditorExternalReload(
  target: EditorExternalWatchTarget,
  notification: EditorExternalWatchNotification,
  file: OpenFile,
  recentSelfWrite: RecentSelfWrite
): void {
  if (recentSelfWrite.content === null) {
    scheduleDebouncedEditorExternalReload(notification)
    return
  }
  const runtimeEnvironmentId = file.runtimeEnvironmentId ?? target.runtimeEnvironmentId
  // Self-write TTL proves recency only; compare content so newer agent writes within it still surface.
  void readFileForEchoVerification({
    runtimeEnvironmentId,
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    connectionId: target.connectionId,
    expectedExternalSshTargetId: file.externalSshTargetId
  })
    .then((result) => {
      if (
        (result.isBinary || result.content !== recentSelfWrite.content) &&
        hasCleanExternalReloadTarget(notification)
      ) {
        clearSelfWrite(file.filePath, runtimeEnvironmentId)
        scheduleDebouncedEditorExternalReload(notification)
      }
    })
    .catch(() => {
      if (hasCleanExternalReloadTarget(notification)) {
        clearSelfWrite(file.filePath, runtimeEnvironmentId)
        scheduleDebouncedEditorExternalReload(notification)
      }
    })
}

function hasCleanExternalReloadTarget(notification: EditorExternalWatchNotification): boolean {
  const matching = getOpenFilesForExternalFileChange(useAppStore.getState().openFiles, notification)
  return matching.some((file) => !file.isDirty)
}
