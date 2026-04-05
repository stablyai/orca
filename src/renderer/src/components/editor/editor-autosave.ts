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

export type EditorPathMutationTarget = {
  worktreeId: string
  worktreePath: string
  relativePath: string
}

export type EditorSaveQuiesceTarget = { fileId: string } | EditorPathMutationTarget

export type EditorSaveQuiesceDetail = EditorSaveQuiesceTarget & {
  claim: () => void
  resolve: () => void
}

export function canAutoSaveOpenFile(file: OpenFile): boolean {
  // Why: single-file editors and one-file unstaged diffs have an unambiguous
  // write target. Combined diff and conflict-review tabs can represent multiple
  // paths, so autosave must stay out of those surfaces until they have their
  // own save coordination instead of guessing which file should be written.
  return file.mode === 'edit' || (file.mode === 'diff' && file.diffSource === 'unstaged')
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
  return openFiles.filter((file) => {
    if (file.worktreeId !== target.worktreeId) {
      return false
    }
    if (file.mode === 'edit') {
      return file.filePath === absolutePath
    }
    if (file.mode === 'diff') {
      return file.diffSource === 'unstaged' && file.relativePath === target.relativePath
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

export function notifyEditorExternalFileChange(target: EditorPathMutationTarget): void {
  window.dispatchEvent(
    new CustomEvent<EditorPathMutationTarget>(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
      detail: target
    })
  )
}
