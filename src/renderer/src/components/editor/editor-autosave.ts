import { joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor'
import { areLocalWindowsWslPathAliases } from '../../../../shared/cross-platform-path'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import {
  DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
  MAX_EDITOR_AUTO_SAVE_DELAY_MS,
  MIN_EDITOR_AUTO_SAVE_DELAY_MS
} from '../../../../shared/constants'
import { clampNumber } from '@/lib/terminal-theme'
import { isAutosavePausedForNonUtf8File } from './editor-non-utf8-autosave-pause'

export const ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT = 'orca:editor-quiesce-file-saves'
export const ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT = 'orca:editor-external-file-change'
export const ORCA_EDITOR_SAVE_FILE_EVENT = 'orca:editor-save-file'
export const ORCA_EDITOR_SAVE_AND_CLOSE_EVENT = 'orca:save-and-close'
export const ORCA_EDITOR_FILE_SAVED_EVENT = 'orca:editor-file-saved'
// Drop sibling content caches when their disk baseline advances without cached text.
export const ORCA_EDITOR_FILE_CACHE_STALE_EVENT = 'orca:editor-file-cache-stale'

export function notifyEditorFileCacheStale(fileId: string): void {
  window.dispatchEvent(
    new CustomEvent<{ fileId: string }>(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, { detail: { fileId } })
  )
}
export const ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT = 'orca:editor-request-cmd-save'
export const ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT = 'orca:editor-request-file-close'

export type EditorPathMutationTarget = {
  worktreeId: string
  worktreePath: string
  relativePath: string
  runtimeEnvironmentId?: string | null
  allowLocalWindowsWslAliases?: true
  indexedOpenFiles?: {
    matches: (openFiles: OpenFile[]) => OpenFile[]
  }
}

export type EditorSaveQuiesceTarget =
  | {
      fileId: string
      /** Don't Save: no flush, and autosave held until the release runs. */ discard?: true
    }
  | EditorPathMutationTarget

export type EditorSaveQuiesceDetail = EditorSaveQuiesceTarget & {
  claim: () => void
  resolve: () => void
  reject?: (message: string) => void
  /** A path or discard quiesce holds autosave of that file in every workspace until this release runs. */
  onHold?: (release: () => void) => void
}

export type EditorSaveFileTarget = {
  fileId: string
  fallbackContent?: string
  /** Only the conflict banner's Overwrite sets this. */
  overwrite?: true
  /** Only the user's confirmation to replace a non-UTF-8 file's unreadable characters sets this. */
  convertToUtf8?: true
}

export type EditorSaveAndCloseDetail = {
  fileId: string
  /** Called at once when the tab stays open, so a waiting dialog needn't time out. */
  onNotClosed?: (reason: 'blocked-stale' | 'not-utf8' | 'not-saved') => void
}

export type EditorSaveFileDetail = EditorSaveFileTarget & {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorFileSavedDetail = {
  fileId: string
  content: string
  /** Every view of the saved record, read when the write landed: the saving view may close. */
  recordViewIds?: readonly string[]
}

export type EditorRequestFileCloseDetail = {
  fileId: string
  /** Runs once the file actually closes — after save or discard, never on cancel. */
  onClosed?: () => void
}

export type EditorRequestCmdSaveDetail = {
  fileId: string
}

export function isExternalReloadableEditorTab(file: OpenFile): boolean {
  return (
    file.mode === 'edit' ||
    file.mode === 'markdown-preview' ||
    (file.mode === 'diff' && (file.diffSource === 'unstaged' || file.diffSource === 'staged'))
  )
}

export function canAutoSaveOpenFile(file: OpenFile): boolean {
  // Never autosave provider-owned transcripts or CSV preview placeholders; either can overwrite content the editor does not own.
  if (file.readOnly === true || file.csvPreviewOnly === true) {
    return false
  }
  // Only edit and unstaged single-file diffs have one write target; multi-file surfaces need separate save coordination.
  return file.mode === 'edit' || (file.mode === 'diff' && file.diffSource === 'unstaged')
}

// Share one suspension rule across queue and timers: marked conflicts pause until resolved; unmarked conflicts are still rejected by guarded writes.
export function isAutosaveSuspendedForFile(
  file: Pick<
    OpenFile,
    'externalMutation' | 'pendingOwnerMigration' | 'filePath' | 'runtimeEnvironmentId'
  >
): boolean {
  return (
    file.externalMutation === 'changed' ||
    file.pendingOwnerMigration === true ||
    isAutosavePausedForNonUtf8File(file)
  )
}

export function normalizeAutoSaveDelayMs(value: unknown): number {
  // Clamp missing or hand-edited persisted settings so autosave cannot become an immediate loop or an excessive wait.
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
  if (target.indexedOpenFiles) {
    return target.indexedOpenFiles.matches(openFiles)
  }
  const absolutePath = joinPath(target.worktreePath, target.relativePath)
  const hasRuntimeOwnerFilter = Object.hasOwn(target, 'runtimeEnvironmentId')
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
      return (
        file.filePath === absolutePath ||
        (target.allowLocalWindowsWslAliases === true &&
          isLocalWindowsDesktopClient() &&
          areLocalWindowsWslPathAliases(file.filePath, absolutePath))
      )
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

/** Resolves to a release for the autosave hold a path quiesce takes; call it once git finishes. */
export async function requestEditorSaveQuiesce(
  target: EditorSaveQuiesceTarget
): Promise<() => void> {
  let release = (): void => {}
  await new Promise<void>((resolve, reject) => {
    let claimed = false
    window.dispatchEvent(
      new CustomEvent<EditorSaveQuiesceDetail>(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, {
        detail: {
          ...target,
          claim: () => {
            claimed = true
          },
          resolve,
          reject: (message) => reject(new Error(message)),
          onHold: (hold) => {
            release = hold
          }
        }
      })
    )
    // Discard/delete can run with no mounted controller; unclaimed quiesce requests must resolve rather than hang.
    if (!claimed) {
      resolve()
    }
  })
  return release
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
    // Unlike quiesce, unclaimed saves must fail so Cmd/Ctrl+S cannot silently drop the user’s write.
    if (!claimed) {
      reject(new Error('Editor save controller is unavailable.'))
    }
  })
}

export function requestEditorFileClose(
  fileId: string,
  options?: Pick<EditorRequestFileCloseDetail, 'onClosed'>
): void {
  window.dispatchEvent(
    new CustomEvent<EditorRequestFileCloseDetail>(ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT, {
      detail: { fileId, ...options }
    })
  )
}

// CONTRACT: consumers must skip dirty files individually; this event can include dirty tabs whose drafts must survive reload.
export function notifyEditorExternalFileChange(target: EditorPathMutationTarget): void {
  window.dispatchEvent(
    new CustomEvent<EditorPathMutationTarget>(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
      detail: target
    })
  )
}
