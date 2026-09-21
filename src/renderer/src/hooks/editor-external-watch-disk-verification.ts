import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { joinPath } from '@/lib/path'
import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange
} from '@/components/editor/editor-autosave'
import { markFileChangedOnDisk } from '@/components/editor/editor-changed-on-disk-mark'
import { getDiskBaselineSignature } from '@/components/editor/diff-content-signature'
import {
  clearSelfWrite,
  getRecentSelfWrite,
  type RecentSelfWrite
} from '@/components/editor/editor-self-write-registry'
import { readRuntimeFileContent } from '@/runtime/runtime-file-client'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

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

// Why: atomic writes burst same-path events; one reload dispatch each fans out into N EditorPanel rebuilds that can wedge the renderer (issue #826), so debounce per owner+path.
const EXTERNAL_RELOAD_DEBOUNCE_MS = 75
const pendingExternalReloadTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleDebouncedEditorExternalReload(
  notification: EditorExternalWatchNotification
): void {
  const key = `${notification.worktreeId}::${notification.runtimeEnvironmentId ?? 'client'}::${notification.relativePath}`
  const existing = pendingExternalReloadTimers.get(key)
  if (existing !== undefined) {
    globalThis.clearTimeout(existing)
  }
  const handle = globalThis.setTimeout(() => {
    pendingExternalReloadTimers.delete(key)
    notifyEditorExternalFileChange(notification)
  }, EXTERNAL_RELOAD_DEBOUNCE_MS)
  pendingExternalReloadTimers.set(key, handle)
}

const inFlightEchoVerificationReads = new Map<string, ReturnType<typeof readRuntimeFileContent>>()

// Why: one save echo can arrive as a burst of payloads; share the in-flight full-file read so concurrent payloads for the same file don't stack duplicate reads.
function readFileForEchoVerification(args: {
  runtimeEnvironmentId: string | null | undefined
  filePath: string
  relativePath: string
  worktreeId: string | null | undefined
  connectionId: string | undefined
  expectedExternalSshTargetId?: string
}): ReturnType<typeof readRuntimeFileContent> {
  const key = [
    args.runtimeEnvironmentId ?? '',
    args.connectionId ?? '',
    args.expectedExternalSshTargetId ?? '',
    args.filePath
  ].join('::')
  let pending = inFlightEchoVerificationReads.get(key)
  if (!pending) {
    pending = readRuntimeFileContent({
      settings: args.runtimeEnvironmentId
        ? { activeRuntimeEnvironmentId: args.runtimeEnvironmentId }
        : null,
      filePath: args.filePath,
      relativePath: args.relativePath,
      worktreeId: args.worktreeId ?? undefined,
      connectionId: args.connectionId,
      expectedExternalSshTargetId: args.expectedExternalSshTargetId
    })
    inFlightEchoVerificationReads.set(key, pending)
    const release = (): void => {
      if (inFlightEchoVerificationReads.get(key) === pending) {
        inFlightEchoVerificationReads.delete(key)
      }
    }
    pending.then(release, release)
  }
  return pending
}

function markTabsChangedOnDisk(fileIds: string[], connectionId: string | undefined): void {
  const state = useAppStore.getState()
  for (const fileId of fileIds) {
    const file = state.openFiles.find((candidate) => candidate.id === fileId)
    // Why: echo verification resolves async — the tab may have been closed since, so only mark files still open.
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
  // Why: the fs event may be the echo of Orca's own save — verify disk really differs from our last write before showing a "changed on disk" banner.
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
      // Why: unreadable disk state can't disprove an external change — keep the conflict visible rather than risk a silent overwrite.
      markTabsChangedOnDisk(fileIds, target.connectionId)
    })
}

// Per-file generation so a newer echo-verify read supersedes an older one — overlapping reads can't clear each other's autosave gate or apply a stale verdict.
const liveMoveVerifyGeneration = new Map<string, number>()
let liveMoveVerifyCounter = 0

type LiveMoveVerifyCandidate = {
  fileId: string
  baseline: string | undefined
  generation: number
  /** The move that installed the provenance; a newer move re-homing the tab supersedes this verification, even across a rekey. */
  operationId?: string
}

// Fails closed: anything but a proven baseline match surfaces the conflict, so a real external write is never swallowed.
function resolveLiveMoveVerification(
  candidate: LiveMoveVerifyCandidate,
  diskSignature: string | null,
  connectionId: string | undefined,
  consumeProvenance: boolean
): void {
  const { fileId, baseline, generation, operationId } = candidate
  if (liveMoveVerifyGeneration.get(fileId) !== generation) {
    return
  }
  liveMoveVerifyGeneration.delete(fileId)
  const state = useAppStore.getState()
  state.setPendingLiveDiskVerification(fileId, false)
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
  const isMoveEcho = baseline !== undefined && diskSignature === baseline
  if (!isMoveEcho) {
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

// Autosave is suspended synchronously first so a write landing mid-read can't be overwritten before verification settles.
export function scheduleEditorSelfMoveEchoVerification(
  target: EditorExternalWatchTarget,
  fileIds: string[],
  consumeProvenance: boolean
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
    state.setPendingLiveDiskVerification(fileId, true)
    const candidate: LiveMoveVerifyCandidate = {
      fileId,
      baseline: file.lastKnownDiskSignature,
      generation,
      operationId: file.pendingSelfMoveEcho?.operationId
    }
    // Why: cross-worktree tabs must read their own absolute path; joining their relative path to the initiating worktree can address the wrong host path.
    void readFileForEchoVerification({
      runtimeEnvironmentId: file.runtimeEnvironmentId?.trim() || target.runtimeEnvironmentId,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      connectionId: target.connectionId,
      expectedExternalSshTargetId: file.externalSshTargetId
    })
      .then((result) => {
        const diskSignature = result.isBinary ? null : getDiskBaselineSignature(result.content)
        resolveLiveMoveVerification(
          candidate,
          diskSignature,
          target.connectionId,
          consumeProvenance
        )
      })
      .catch(() =>
        resolveLiveMoveVerification(candidate, null, target.connectionId, consumeProvenance)
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
  // Why: a self-write stamp only proves recent change; compare disk content so it suppresses only Orca's echo, not a newer agent write in the same TTL.
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
