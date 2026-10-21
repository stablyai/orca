import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { toEditorModelUri } from './editor-model-uri'
import { getEditorModelOwnerKey } from './editor-model-owner'
import { detectLanguage } from '@/lib/language-detect'
import { getDefaultMarkdownViewMode, getMarkdownViewModes } from './markdown-preview-controls'
import type { FileWriteResult } from '../../../../shared/file-write-disk-precondition'
import type { LocalFileAccess } from '../../../../shared/local-file-access'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { writeRuntimeFile } from '@/runtime/runtime-file-mutation-client'

/**
 * `user`: an explicit desktop save (shortcut, save-and-close dialog). `restart`: the save-all
 * before a restart. `overwrite`: the conflict banner's Overwrite, the only consent to replace a
 * disk change.
 */
export type EditorSaveTrigger = 'autosave' | 'user' | 'restart' | 'overwrite'

/**
 * `written`: disk holds the text. `blocked-stale`: the host refused because disk moved on since the
 * tab's baseline. `failed`: nothing was written (read-only, suspended, superseded). Write errors reject.
 * Callers treat anything but `written` as not saved.
 */
export type EditorSaveResult = 'written' | 'blocked-stale' | 'failed'

export const EDITOR_STALE_SAVE_MESSAGE =
  'This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.'

/** The Monaco model a tab edits; tabs of one file on one host share it, and so share its text. */
export function editorTabModelUri(state: AppState, file: OpenFile): string {
  return toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state))
}

/** Whether the tab edits its Monaco model directly; rich, notebook, CSV and preview views don't. */
function isCodeViewTab(state: AppState, file: OpenFile): boolean {
  // Why: the Changes view renders its own diff model, not the shared text model.
  if (file.mode !== 'edit' || state.editorViewMode?.[file.id] === 'changes') {
    return false
  }
  const target = { language: detectLanguage(file.filePath), mode: file.mode }
  const views = getMarkdownViewModes(target)
  const stored = state.markdownViewMode?.[file.id]
  const view =
    stored !== undefined && views.includes(stored) ? stored : getDefaultMarkdownViewMode(target)
  return views.length === 0 || view === 'source'
}

/**
 * Code-view tabs showing the same live model as `file`, `file` included. They share the model's
 * text, so a write or Keep may advance their baseline; any other view is guarded on its own.
 */
export function editorModelSiblingTabs(state: AppState, file: OpenFile): OpenFile[] {
  if (!isCodeViewTab(state, file)) {
    return [file]
  }
  const modelUri = editorTabModelUri(state, file)
  return state.openFiles.filter(
    (tab) =>
      tab.id === file.id ||
      (isCodeViewTab(state, tab) && editorTabModelUri(state, tab) === modelUri)
  )
}

/**
 * What an editor save may do. There is no plain-write case: a save is either compared against a
 * known disk version, the banner's explicit Overwrite, or refused. A host without the guarded
 * write gets the writer's compatibility fallback: the client reads and compares, then writes.
 */
export type EditorSavePrecondition =
  | { kind: 'guarded'; signature: string; allowMissing: boolean }
  | { kind: 'explicit-overwrite' }
  | { kind: 'blocked'; reason: 'no-baseline' }

export type EditorSaveWrite = Exclude<EditorSavePrecondition, { kind: 'blocked' }>

/** A code-view model is dirty when any tab of it holds unsaved edits; other views answer for themselves. */
export function isEditorModelDirty(state: AppState, file: OpenFile): boolean {
  return editorModelSiblingTabs(state, file).some((tab) => tab.isDirty)
}

/** The tab holding the model's unsaved text; it may be a sibling of `file`, not `file` itself. */
export function editorModelDraftHolder(state: AppState, file: OpenFile): OpenFile | undefined {
  return editorModelSiblingTabs(state, file).find(
    (tab) => tab.isDirty && state.editorDrafts[tab.id] !== undefined
  )
}

/**
 * The one disk version of a code-view model: every tab sharing the model holds the same value, set
 * only here. Other views keep their own. Returns the sibling tabs whose value moved.
 */
export function setEditorDiskBaseline(
  state: AppState,
  fileId: string,
  signature: string | undefined
): OpenFile[] {
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  const moved: OpenFile[] = []
  for (const tab of file ? editorModelSiblingTabs(state, file) : []) {
    if (tab.lastKnownDiskSignature !== signature) {
      state.setLastKnownDiskSignature(tab.id, signature)
      if (tab.id !== fileId) {
        moved.push(tab)
      }
    }
  }
  return moved
}

/**
 * A guarded save is refused when disk no longer holds the version its text came from, so an
 * unnoticed external write is never silently overwritten.
 */
export function editorSavePrecondition(
  file: OpenFile,
  trigger: EditorSaveTrigger
): EditorSavePrecondition {
  // Why: only the visible banner's Overwrite may replace a disk change the user was shown.
  if (trigger === 'overwrite') {
    return { kind: 'explicit-overwrite' }
  }
  const baseline = file.lastKnownDiskSignature
  if (baseline === undefined) {
    return { kind: 'blocked', reason: 'no-baseline' }
  }
  // Why: autosave must not resurrect a file deleted behind the editor's back; explicit saves may.
  return { kind: 'guarded', signature: baseline, allowMissing: trigger !== 'autosave' }
}

/** The only file write editor save code makes. */
export function writeEditorSave(
  context: RuntimeFileOperationArgs,
  filePath: string,
  content: string,
  access: LocalFileAccess | undefined,
  write: EditorSaveWrite
): Promise<FileWriteResult> {
  return writeRuntimeFile(
    context,
    filePath,
    content,
    access,
    write.kind === 'guarded'
      ? { expectedSignature: write.signature, allowMissing: write.allowMissing }
      : undefined
  )
}

// Why both clear when the read settles: entries live only while a Keep My Edits read is pending.
const pendingBaselineRestamps = new Map<string, Promise<void>>()
const supersededBaselineRestamps = new Set<string>()

/** A completed write re-baselines the tab, so a Keep read that started earlier must not restamp. */
export function noteEditorBaselineWrite(fileId: string): void {
  if (pendingBaselineRestamps.has(fileId)) {
    supersededBaselineRestamps.add(fileId)
  }
}

export function isEditorBaselineRestampSuperseded(fileId: string): boolean {
  return supersededBaselineRestamps.has(fileId)
}

/** Registers Keep My Edits' disk read so saves of that tab wait for its new baseline. */
export function trackEditorBaselineRestamp(fileId: string, restamp: Promise<void>): void {
  const tracked = restamp.catch(() => undefined)
  pendingBaselineRestamps.set(fileId, tracked)
  supersededBaselineRestamps.delete(fileId)
  void tracked.then(() => {
    if (pendingBaselineRestamps.get(fileId) === tracked) {
      pendingBaselineRestamps.delete(fileId)
      supersededBaselineRestamps.delete(fileId)
    }
  })
}

export function waitForEditorBaselineRestamp(fileId: string): Promise<void> {
  return pendingBaselineRestamps.get(fileId) ?? Promise.resolve()
}
