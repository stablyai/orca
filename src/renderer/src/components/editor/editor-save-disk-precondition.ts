import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { toEditorModelUri } from './editor-model-uri'
import { getEditorModelOwnerKey } from './editor-model-owner'
import { editorBufferSiblingViewIds } from '@/store/slices/editor/buffers/editor-buffer-views'
import { detectLanguage } from '@/lib/language-detect'
import { getDefaultMarkdownViewMode, getMarkdownViewModes } from './markdown-preview-controls'
import type { FileWriteResult } from '../../../../shared/file-write-disk-precondition'
import type { LocalFileAccess } from '../../../../shared/local-file-access'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { writeRuntimeFile } from '@/runtime/runtime-file-mutation-client'
import { writeRuntimeTerminalArtifactFile } from '@/runtime/runtime-terminal-artifact-write'
import { getRelativePathInsideWorktree } from '@/runtime/runtime-file-routing'
import { chatScratchFileAddress } from '@/runtime/runtime-chat-scratch-file-address'
import { grantRestoredHostFile } from './restored-host-file-grant'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'

/** Only overwrite grants disk-conflict consent; convert grants non-UTF-8 conversion consent. Other explicit saves remain guarded. */
export type EditorSaveTrigger = 'autosave' | 'user' | 'convert' | 'restart' | 'overwrite'

/** Only written counts as saved; refusals return a reason and write errors reject. */
export type EditorSaveResult = 'written' | 'blocked-stale' | 'not-utf8' | 'failed'

export const EDITOR_STALE_SAVE_MESSAGE =
  'This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.'

export const EDITOR_NOT_UTF8_SAVE_MESSAGE = "This file isn't UTF-8 text, so it wasn't saved."

export function editorTabModelUri(state: AppState, file: OpenFile): string {
  return toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state))
}

/** Exclude rich, notebook, CSV and preview views that do not directly edit the shared model. */
export function isCodeViewTab(state: AppState, file: OpenFile): boolean {
  // Changes uses a separate diff model.
  if (file.mode !== 'edit' || state.editorViewMode?.[file.id] === 'changes') {
    return false
  }
  // Read-only tabs always render raw Monaco source, regardless of type.
  if (file.readOnly === true) {
    return true
  }
  const target = { language: detectLanguage(file.filePath), mode: file.mode }
  const views = getMarkdownViewModes(target)
  const stored = state.markdownViewMode?.[file.id]
  const view =
    stored !== undefined && views.includes(stored) ? stored : getDefaultMarkdownViewMode(target)
  return views.length === 0 || view === 'source'
}

export function editorModelSiblingTabs(state: AppState, file: OpenFile): OpenFile[] {
  const viewIds = new Set(editorBufferSiblingViewIds(state, file.id))
  viewIds.add(file.id)
  const views = state.openFiles.filter((tab) => viewIds.has(tab.id))
  return views.some((tab) => tab.id === file.id) ? views : [file, ...views]
}

/** Require a known baseline or explicit overwrite; older hosts fall back to client compare-before-write. */
export type EditorSavePrecondition =
  | { kind: 'guarded'; signature: string; allowMissing: boolean; requireLosslessUtf8?: boolean }
  | { kind: 'explicit-overwrite' }
  | { kind: 'blocked'; reason: 'no-baseline' }

export type EditorSaveWrite = Exclude<EditorSavePrecondition, { kind: 'blocked' }>

export function isEditorModelDirty(state: AppState, file: OpenFile): boolean {
  return editorModelSiblingTabs(state, file).some((tab) => tab.isDirty)
}

export function editorModelDraftHolder(state: AppState, file: OpenFile): OpenFile | undefined {
  return editorModelSiblingTabs(state, file).find(
    (tab) => tab.isDirty && state.editorDrafts[tab.id] !== undefined
  )
}

/** Advance the record’s shared baseline and return sibling views whose baseline changed. */
export function setEditorDiskBaseline(
  state: AppState,
  fileId: string,
  signature: string | undefined
): OpenFile[] {
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  if (!file) {
    return []
  }
  const moved = editorModelSiblingTabs(state, file).filter(
    (tab) => tab.id !== fileId && tab.lastKnownDiskSignature !== signature
  )
  state.setLastKnownDiskSignature(fileId, signature)
  return moved
}

export function editorSavePrecondition(
  file: OpenFile,
  trigger: EditorSaveTrigger
): EditorSavePrecondition {
  // Only banner Overwrite grants consent to replace a known disk change.
  if (trigger === 'overwrite') {
    return { kind: 'explicit-overwrite' }
  }
  const baseline = file.lastKnownDiskSignature
  if (baseline === undefined) {
    return { kind: 'blocked', reason: 'no-baseline' }
  }
  // Autosave must not resurrect deleted files; explicit saves may.
  return {
    kind: 'guarded',
    signature: baseline,
    allowMissing: trigger !== 'autosave',
    // Only confirmed conversion may replace bytes that failed UTF-8 decoding.
    requireLosslessUtf8: trigger !== 'convert'
  }
}

/** The tab's host grant for a file outside every workspace; a renewed grant is kept on the tab. */
export type EditorSaveGrant = {
  grantId: string
  onRenewed: (grantId: string) => void
  /** Captured before any await so a same-id re-pair cannot retarget the save. */
  expectedEnvironmentPairingRevision?: number
}

/** Sync unless a restored tab must ask its host, so ordinary saves gain no await before their pairing pin. */
export function editorSaveGrant(
  file: OpenFile,
  context: RuntimeFileOperationArgs,
  getState: () => Pick<AppState, 'setTerminalArtifactGrant'>
): EditorSaveGrant | Promise<EditorSaveGrant> | undefined {
  const onRenewed = (renewed: string): void => getState().setTerminalArtifactGrant(file.id, renewed)
  const expectedEnvironmentPairingRevision =
    context.target.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(context.target.environmentId)
      : undefined
  if (file.terminalArtifactGrantId) {
    return { grantId: file.terminalArtifactGrantId, onRenewed, expectedEnvironmentPairingRevision }
  }
  // Why: grants are never persisted, so a restored tab that never loaded asks its host before saving.
  if (
    context.target.kind !== 'environment' ||
    file.relativePath !== file.filePath ||
    getRelativePathInsideWorktree(context.worktreePath, file.filePath) !== null ||
    chatScratchFileAddress(file.filePath)
  ) {
    return undefined
  }
  const target = context.target
  return (async () => {
    const restored = await grantRestoredHostFile(
      target,
      context.worktreeId,
      file.filePath,
      expectedEnvironmentPairingRevision
    )
    // Why: refuse rather than mark the tab read-only, which would drop its draft from the session.
    if (restored.readOnly) {
      throw new Error('This host opens the file read-only.')
    }
    onRenewed(restored.grantId)
    return { grantId: restored.grantId, onRenewed, expectedEnvironmentPairingRevision }
  })()
}

export function writeEditorSave(
  context: RuntimeFileOperationArgs,
  filePath: string,
  content: string,
  access: LocalFileAccess | undefined,
  write: EditorSaveWrite,
  beforeSend?: () => void,
  grant?: EditorSaveGrant | Promise<EditorSaveGrant>
): Promise<FileWriteResult> {
  const precondition =
    write.kind === 'guarded'
      ? {
          expectedSignature: write.signature,
          allowMissing: write.allowMissing,
          ...(write.requireLosslessUtf8 ? { requireLosslessUtf8: true } : {})
        }
      : undefined
  if (grant) {
    // Why: a granted host file must never fall through to a write of this computer's same path.
    if (context.target.kind !== 'environment' || !context.worktreeId) {
      throw new Error('This file belongs to a host that is no longer this tab’s owner.')
    }
    const target = context.target
    const worktreeId = context.worktreeId
    return Promise.resolve(grant).then((resolved) =>
      writeRuntimeTerminalArtifactFile({
        target,
        worktreeId,
        absolutePath: filePath,
        grantId: resolved.grantId,
        content,
        precondition,
        beforeSend,
        onGrantRenewed: resolved.onRenewed,
        expectedEnvironmentPairingRevision: resolved.expectedEnvironmentPairingRevision
      })
    )
  }
  return writeRuntimeFile(context, filePath, content, access, precondition, beforeSend)
}

// Release both markers when the pending Keep My Edits read settles.
const pendingBaselineRestamps = new Map<string, Promise<void>>()
const supersededBaselineRestamps = new Set<string>()

/** Prevent an older Keep My Edits read from restamping a newer write’s baseline. */
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
