import { getPersistedEditorOwnerFields } from '@/lib/editor-file-operation-owner'
import { toast } from 'sonner'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import { restoreRecentlyClosedTabPosition } from '../../recently-closed-tabs'
import { buildEditorActiveResult } from '../tabs/editor-open-target-group'
import { deferRecoveredEditorDraft } from './parked-recovered-editor-drafts'
import { editorDocumentPathOwnerKey } from '../file-ids/editor-document-identity'
import {
  recoveredDraftBlockedMessage,
  type RecoveredDraftBlockReason
} from './recovered-draft-block-notice'
import {
  canReuseLocalWslAlias,
  getReusableOpenFileModes,
  isSameEditorOwner,
  matchesEditorMode
} from '../file-ids/editor-file-ids'

export function reopenRecoveredEditorTab(
  set: EditorSet,
  get: EditorGet,
  worktreeId: string
): boolean {
  const stack = get().recentlyClosedEditorTabsByWorktree[worktreeId] ?? []
  const next = stack[0]
  if (!next) {
    return false
  }
  set((s) => ({
    recentlyClosedEditorTabsByWorktree: {
      ...s.recentlyClosedEditorTabsByWorktree,
      [worktreeId]: (s.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []).slice(1)
    }
  }))
  const { position, reopenId, dirtyDraftContent, ...snapshotFile } = next
  const file = { ...snapshotFile, ...getPersistedEditorOwnerFields(snapshotFile) }
  const deferDraft = (): void => {
    set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
  }
  const notifyBlocked = (reason: RecoveredDraftBlockReason): void => {
    toast.info(recoveredDraftBlockedMessage(reason, file))
  }
  // Raise both the unified tab and its editor surface.
  const activateLiveRecord = (liveFileId: string): void => {
    get().setActiveFile(liveFileId)
    set((s) => buildEditorActiveResult(s, file.worktreeId, liveFileId))
  }
  // Keep newer live baselines; a missing baseline cannot authorize autosave.
  const adoptSnapshotDiskBaseline = (liveFileId: string): void => {
    const liveFile = get().openFiles.find((f) => f.id === liveFileId)
    if (!liveFile || liveFile.lastKnownDiskSignature !== undefined) {
      return
    }
    if (next.lastKnownDiskSignature === undefined) {
      get().setExternalMutation(liveFileId, 'changed')
      return
    }
    get().setLastKnownDiskSignature(liveFileId, next.lastKnownDiskSignature)
    get().setPendingDiskBaselineVerification(liveFileId, true)
  }
  if (dirtyDraftContent !== undefined) {
    // Check collisions before openFile can reuse a live record or add a second tab.
    const beforeCollisionCheck = get()
    // Match openFile's reuse rule, which ignores readOnly and liveTail.
    const identity = editorDocumentPathOwnerKey(file)
    const modes = getReusableOpenFileModes(file.mode)
    const candidateIdentity = (
      candidate: (typeof beforeCollisionCheck.openFiles)[number]
    ): string =>
      editorDocumentPathOwnerKey({ ...candidate, ...getPersistedEditorOwnerFields(candidate) })
    // The normal open path can reuse an unstamped SSH tab; protect its captured owner first.
    const rivalOwner = beforeCollisionCheck.openFiles.find(
      (candidate) =>
        matchesEditorMode(candidate, modes) &&
        isSameEditorOwner(candidate, file.worktreeId, file.runtimeEnvironmentId) &&
        (candidate.filePath === file.filePath ||
          canReuseLocalWslAlias(
            beforeCollisionCheck,
            candidate,
            file,
            file.runtimeEnvironmentId
          )) &&
        candidateIdentity({ ...candidate, filePath: file.filePath }) !== identity
    )
    if (rivalOwner) {
      deferDraft()
      notifyBlocked('other-owner')
      return true
    }
    const matches = beforeCollisionCheck.openFiles.filter(
      (candidate) =>
        matchesEditorMode(candidate, modes) && candidateIdentity(candidate) === identity
    )
    // Prefer a writable twin that can retain the draft.
    const live = matches.find((candidate) => candidate.readOnly !== true) ?? matches[0]
    const liveDraft = live ? beforeCollisionCheck.editorDrafts[live.id] : undefined
    if (live?.readOnly === true) {
      // A read-only record cannot retain this draft or its baseline.
      deferDraft()
      activateLiveRecord(live.id)
      notifyBlocked('read-only')
      return true
    }
    if (live && liveDraft === dirtyDraftContent) {
      // Identical text must not replace a newer live baseline.
      adoptSnapshotDiskBaseline(live.id)
      activateLiveRecord(live.id)
      return true
    }
    if (live && (liveDraft !== undefined || live.isDirty === true)) {
      // Preserve the rival unsaved text for a later reopen.
      deferDraft()
      activateLiveRecord(live.id)
      notifyBlocked('unsaved-rival')
      return true
    }
  }
  // Path aliases can still reuse a live record; preserve its draft before opening.
  const beforeOpen = get()
  let restoredFileId: string
  try {
    restoredFileId = get().openFile(file, {
      targetGroupId: position?.groupId,
      reopenId
    })
  } catch (error) {
    deferDraft()
    throw error
  }
  if (
    dirtyDraftContent !== undefined &&
    get().openFiles.find((f) => f.id === restoredFileId)?.readOnly === true
  ) {
    // Reuse may select a read-only record, whose draft setters do nothing.
    deferDraft()
    notifyBlocked('read-only')
    return true
  }
  const reusedLiveRecord = beforeOpen.openFiles.find((f) => f.id === restoredFileId)
  const priorDraft = beforeOpen.editorDrafts[restoredFileId]
  const reusedRecordHasUnsavedWork =
    reusedLiveRecord && (priorDraft !== undefined || reusedLiveRecord.isDirty === true)
  if (dirtyDraftContent !== undefined && reusedRecordHasUnsavedWork) {
    if (priorDraft === dirtyDraftContent) {
      // Identical text must not replace a newer live baseline.
      adoptSnapshotDiskBaseline(restoredFileId)
      return true
    }
    // Preserve the draft until the reused record can safely accept it.
    deferDraft()
    notifyBlocked('unsaved-rival')
    return true
  }
  if (dirtyDraftContent !== undefined) {
    get().setEditorDraft(restoredFileId, dirtyDraftContent)
    get().markFileDirty(restoredFileId, true)
    // Verify the recovered draft's disk baseline before autosave resumes.
    if (next.lastKnownDiskSignature !== undefined) {
      get().setLastKnownDiskSignature(restoredFileId, next.lastKnownDiskSignature)
      get().setPendingDiskBaselineVerification(restoredFileId, true)
    } else {
      // No baseline means an automatic overwrite cannot be verified safe.
      get().setExternalMutation(restoredFileId, 'changed')
    }
  }
  restoreRecentlyClosedTabPosition(get, worktreeId, restoredFileId, position)
  return true
}
