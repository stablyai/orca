import { joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor'
import {
  DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
  MAX_EDITOR_AUTO_SAVE_DELAY_MS,
  MIN_EDITOR_AUTO_SAVE_DELAY_MS
} from '../../../../shared/constants'
import { clampNumber } from '@/lib/terminal-theme'

export const ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT = 'orca:editor-quiesce-file-saves'
export const ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT = 'orca:editor-external-file-change'
export const ORCA_EDITOR_SAVE_FILE_EVENT = 'orca:editor-save-file'
export const ORCA_EDITOR_SAVE_AND_CLOSE_EVENT = 'orca:save-and-close'
export const ORCA_EDITOR_FILE_SAVED_EVENT = 'orca:editor-file-saved'
export const ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT = 'orca:editor-request-cmd-save'
export const ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT = 'orca:editor-request-file-close'

export type EditorPathMutationTarget = {
  worktreeId: string
  worktreePath: string
  relativePath: string
  runtimeEnvironmentId?: string | null
}

export type EditorSaveQuiesceTarget = { fileId: string } | EditorPathMutationTarget

export type EditorSaveQuiesceDetail = EditorSaveQuiesceTarget & {
  claim: () => void
  resolve: () => void
}

export type EditorSaveFileTarget = {
  fileId: string
  fallbackContent?: string
}

export type EditorSaveFileDetail = EditorSaveFileTarget & {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorFileSavedDetail = {
  fileId: string
  content: string
}

export type EditorRequestFileCloseDetail = {
  fileId: string
}

export function isExternalReloadableEditorTab(file: OpenFile): boolean {
  return (
    file.mode === 'edit' ||
    file.mode === 'markdown-preview' ||
    (file.mode === 'diff' && (file.diffSource === 'unstaged' || file.diffSource === 'staged'))
  )
}

// Why: combined "Changes"/"All Changes" tabs render working-tree diffs but
// match no single path (their relativePath is a label, filePath the worktree
// root). The fs watcher must still notify them so terminal/agent edits reload
// the affected section. Branch/commit combined diffs compare committed refs, so
// working-tree changes don't affect them and are intentionally excluded.
export function isWorkingTreeCombinedDiffTab(file: OpenFile): boolean {
  return (
    file.mode === 'diff' &&
    (file.diffSource === 'combined-uncommitted' || file.diffSource === 'combined-all')
  )
}

export function canAutoSaveOpenFile(file: OpenFile): boolean {
  // Why: read-only tabs (AI Vault View Log) must never autosave — writing an
  // agent-owned transcript can corrupt the provider's resume history.
  if (file.readOnly === true) {
    return false
  }
  // Why: single-file editors and one-file unstaged diffs have an unambiguous
  // write target. Combined diff and conflict-review tabs can represent multiple
  // paths, so autosave must stay out of those surfaces until they have their
  // own save coordination instead of guessing which file should be written.
  return file.mode === 'edit' || (file.mode === 'diff' && file.diffSource === 'unstaged')
}

// Why: autosave must not resolve a changed-on-disk conflict by overwriting
// the newer external content, nor write over a restored tab whose disk
// baseline is still unverified (the conflict may simply not be marked YET).
// One predicate so the save-queue gate and the timer scheduler cannot drift.
export function isAutosaveSuspendedForFile(
  file: Pick<OpenFile, 'externalMutation' | 'pendingDiskBaselineVerification'>
): boolean {
  return file.externalMutation === 'changed' || file.pendingDiskBaselineVerification === true
}

export function normalizeAutoSaveDelayMs(value: unknown): number {
  // Why: settings are persisted locally and can be missing or hand-edited.
  // Clamp the delay at the write site so autosave never degenerates into an
  // effectively immediate save loop or an unexpectedly huge wait.
  const numericValue =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : null
  const normalizedValue =
    numericValue !== null && Number.isFinite(numericValue)
      ? numericValue
      : DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS
  return clampNumber(normalizedValue, MIN_EDITOR_AUTO_SAVE_DELAY_MS, MAX_EDITOR_AUTO_SAVE_DELAY_MS)
}

export function getOpenFilesForExternalFileChange(
  openFiles: OpenFile[],
  target: EditorPathMutationTarget
): OpenFile[] {
  const absolutePath = joinPath(target.worktreePath, target.relativePath)
  const hasRuntimeOwnerFilter = Object.prototype.hasOwnProperty.call(target, 'runtimeEnvironmentId')
  const targetRuntimeOwner = target.runtimeEnvironmentId?.trim() || null
  return openFiles.filter((file) => {
    if (file.worktreeId !== target.worktreeId) {
      return false
    }
    if (
      hasRuntimeOwnerFilter &&
      (file.runtimeEnvironmentId?.trim() || null) !== targetRuntimeOwner
    ) {
      return false
    }
    if (file.mode === 'edit' || file.mode === 'markdown-preview') {
      return file.filePath === absolutePath
    }
    if (file.mode === 'diff') {
      return (
        (file.diffSource === 'unstaged' || file.diffSource === 'staged') &&
        file.relativePath === target.relativePath
      )
    }
    return false
  })
}

export async function requestEditorSaveQuiesce(target: EditorSaveQuiesceTarget): Promise<void> {
  await new Promise<void>((resolve) => {
    let claimed = false
    window.dispatchEvent(
      new CustomEvent<EditorSaveQuiesceDetail>(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, {
        detail: {
          ...target,
          claim: () => {
            claimed = true
          },
          resolve
        }
      })
    )
    // Why: discard/delete flows also run when no editor tab is mounted. Let
    // those external mutations proceed immediately instead of hanging forever
    // waiting on a quiesce listener that does not exist in that UI state.
    if (!claimed) {
      resolve()
    }
  })
}

export async function requestEditorFileSave(target: EditorSaveFileTarget): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let claimed = false
    window.dispatchEvent(
      new CustomEvent<EditorSaveFileDetail>(ORCA_EDITOR_SAVE_FILE_EVENT, {
        detail: {
          ...target,
          claim: () => {
            claimed = true
          },
          resolve,
          reject: (message) => reject(new Error(message))
        }
      })
    )
    // Why: a direct save request should never report success unless some
    // controller actually accepted responsibility for writing the file. Unlike
    // quiesce, silently no-oping here would make Cmd/Ctrl+S look successful
    // while dropping the user's save entirely.
    if (!claimed) {
      reject(new Error('Editor save controller is unavailable.'))
    }
  })
}

export function requestEditorFileClose(fileId: string): void {
  window.dispatchEvent(
    new CustomEvent<EditorRequestFileCloseDetail>(ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT, {
      detail: { fileId }
    })
  )
}

// CONTRACT: this event fires even when some tabs of the path are dirty —
// every consumer MUST skip dirty files per-file. Reloading a dirty tab's
// content destroys its unsaved draft (the data-loss half of issue #7265).
export function notifyEditorExternalFileChange(target: EditorPathMutationTarget): void {
  window.dispatchEvent(
    new CustomEvent<EditorPathMutationTarget>(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
      detail: target
    })
  )
}
