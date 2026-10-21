import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  EDITOR_STALE_SAVE_MESSAGE,
  isEditorModelDirty,
  setEditorDiskBaseline
} from '@/components/editor/editor-save-disk-precondition'
import { setModelExternalMutation } from '@/components/editor/editor-save-rebaseline'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'

export const MOBILE_STALE_SAVE_MESSAGE =
  'This file changed on the computer. Reload to get the latest version, then reapply your edit.'

/** The shared baseline a phone save adopted, and the one it replaced. */
export type MobileAdoptedBaseline = { adopted: string; previous: string | undefined }

/**
 * When no tab of the model has edits, the version mobile just read from disk becomes the model's
 * baseline for this save. A dirty model keeps its baseline, so the save is refused and the phone told.
 */
export function stampMobileVerifiedBaseline(
  file: OpenFile,
  current: { content: string; source: 'draft' | 'file' }
): MobileAdoptedBaseline | null {
  const state = useAppStore.getState()
  if (current.source !== 'file' || isEditorModelDirty(state, file)) {
    return null
  }
  const adopted = getDiskBaselineSignature(current.content)
  const previous = file.lastKnownDiskSignature
  if (previous === adopted) {
    return null
  }
  setEditorDiskBaseline(state, file.id, adopted)
  return { adopted, previous }
}

/** Puts the desktop tab back as it was and returns the error to send to mobile. */
export function rollBackFailedMobileSave(
  error: unknown,
  save: {
    fileId: string
    injectedContent: string
    previousDraft: string | undefined
    previousDirty: boolean
    stampedBaseline: MobileAdoptedBaseline | null
  }
): unknown {
  restoreFailedMobileSaveDraft(
    save.fileId,
    save.injectedContent,
    save.previousDraft,
    save.previousDirty
  )
  const state = useAppStore.getState()
  const liveFile = state.openFiles.find((openFile) => openFile.id === save.fileId)
  // Why: nothing was written, so the adopted baseline must not outlive the save.
  if (
    save.stampedBaseline !== null &&
    liveFile?.lastKnownDiskSignature === save.stampedBaseline.adopted
  ) {
    setEditorDiskBaseline(state, save.fileId, save.stampedBaseline.previous)
  }
  if (!(error instanceof Error) || error.message !== EDITOR_STALE_SAVE_MESSAGE) {
    return error
  }
  // Why: desktop edits rode along in this save, so the desktop must learn of the conflict too.
  if (save.previousDirty) {
    setModelExternalMutation(state, save.fileId, 'changed')
  }
  return new Error(MOBILE_STALE_SAVE_MESSAGE)
}

function restoreFailedMobileSaveDraft(
  fileId: string,
  injectedContent: string,
  previousDraft: string | undefined,
  previousDirty: boolean
): void {
  const state = useAppStore.getState()
  const currentDraft = state.editorDrafts[fileId]
  if (currentDraft !== undefined && currentDraft !== injectedContent) {
    return
  }
  // Why: mobile save injects a desktop draft only to reuse the editor save path.
  // If save or verification fails, put the desktop editor back exactly as it was before.
  if (previousDraft === undefined) {
    state.clearEditorDraft(fileId)
  } else {
    state.setEditorDraft(fileId, previousDraft)
  }
  state.markFileDirty(fileId, previousDirty)
}
