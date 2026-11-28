import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { editorTabFileAccess, isClientLocalReadOnlyTab } from '@/lib/files/access/local-file-access'
import {
  acquireEditorFileOperation,
  isSameEditorFileOperationIdentity
} from '@/lib/editor/file-operations/editor-file-operation-owner'
import { findFirstIndexedWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'
import { notifyEditorExternalFileChange } from '../../autosave/editor-autosave'
import { editorModelSiblingTabs } from '../../save/queue/editor-save-disk-precondition'

// Tab identity, routing and disk-read helpers shared by the reload entry point and its dirty-model path.

/** What the user sees as the result; the caller turns it into a toast, a status message or nothing. */
export type EditorReloadOutcome =
  | { kind: 'reloaded' }
  /** The file is gone; the reload turns the tab into its deleted state. */
  | { kind: 'deleted' }
  | { kind: 'unchanged' }
  | { kind: 'conflict-shown' }
  | { kind: 'conflict-elsewhere'; sourceTab: OpenFile }
  | { kind: 'cannot-check-dirty' }
  | { kind: 'read-failed'; error: unknown }
  | { kind: 'skipped' }

export type EditorReloadDeps = {
  /** The panel's explicit reload, used for a tab that is showing a load error (its own Retry). */
  retryFailedLoad?: (file: OpenFile) => void
  /** The silent paused-root check: only compare-and-reload text with a baseline; never re-read anything else. */
  background?: boolean
  /** True once a newer explicit reload of this file started; this run's read is then stale. */
  isSuperseded?: () => boolean
}

export function isEditorReloadEligible(file: OpenFile): boolean {
  return (
    (file.mode === 'edit' || file.mode === 'markdown-preview') &&
    !file.isUntitled &&
    file.externalMutation !== 'deleted' &&
    file.externalMutation !== 'renamed' &&
    !file.pendingOwnerMigration
  )
}

export function liveTab(state: AppState, fileId: string): OpenFile | undefined {
  return state.openFiles.find((file) => file.id === fileId)
}

/** A preview renders its source tab's draft, so the source decides dirtiness, baseline and banner. */
export function decisionTab(state: AppState, file: OpenFile): OpenFile {
  const sourceId = file.mode === 'markdown-preview' ? file.markdownPreviewSourceFileId : undefined
  const source = sourceId ? liveTab(state, sourceId) : undefined
  return source && source.filePath === file.filePath ? source : file
}

export function modelBaseline(state: AppState, file: OpenFile): string | undefined {
  return editorModelSiblingTabs(state, file).find((tab) => tab.lastKnownDiskSignature !== undefined)
    ?.lastKnownDiskSignature
}

export function isAbsolutePathTab(file: OpenFile): boolean {
  return file.filePath === file.relativePath
}

/** The host a tab's file lives on: its captured operation owner first, then an explicit SSH target. */
function hostIdentityOf(file: OpenFile): string {
  return (
    file.operationProvenance?.generation.route.executionHostId ??
    (file.externalSshTargetId?.trim() ? `ssh:${file.externalSshTargetId.trim()}` : 'unknown')
  )
}

/** Reload every same-owner view of this path exactly as a watcher event would. */
export function reloadEditorFileThroughWatcherPath(file: OpenFile): void {
  const state = useAppStore.getState()
  const worktreePath =
    findFirstIndexedWorktree(selectWorktreesByRepo(state), file.worktreeId)?.path ?? ''
  const owner = file.runtimeEnvironmentId?.trim() || null
  const host = hostIdentityOf(file)
  const pathKey = normalizeRuntimePathForComparison(file.filePath)
  notifyEditorExternalFileChange({
    worktreeId: file.worktreeId,
    worktreePath,
    relativePath: file.relativePath,
    runtimeEnvironmentId: owner,
    indexedOpenFiles: {
      matches: (openFiles) =>
        openFiles.filter(
          (tab) =>
            tab.worktreeId === file.worktreeId &&
            (tab.runtimeEnvironmentId?.trim() || null) === owner &&
            // A local and an SSH tab can name the same absolute path; never reach across hosts.
            hostIdentityOf(tab) === host &&
            // Same tab kinds a watcher event for this path reaches.
            (tab.mode === 'edit' ||
              tab.mode === 'markdown-preview' ||
              (tab.mode === 'diff' &&
                (tab.diffSource === 'unstaged' || tab.diffSource === 'staged'))) &&
            normalizeRuntimePathForComparison(tab.filePath) === pathKey
        )
    }
  })
}

export async function readDisk(
  state: AppState,
  file: OpenFile,
  wakeWslDistro: boolean
): Promise<{ content: string; isBinary: boolean }> {
  const clientLocal = isClientLocalReadOnlyTab(file) && file.runtimeEnvironmentId === undefined
  // Route exactly like the content loader: the file's captured owner, not the workspace's current host.
  const acquisition = clientLocal ? null : acquireEditorFileOperation(useAppStore.getState, file)
  const result = await readRuntimeFileContent({
    target: acquisition ? acquisition.context.target : { kind: 'local' },
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    connectionId: acquisition?.context.connectionId,
    expectedExternalSshTargetId: file.externalSshTargetId,
    access: editorTabFileAccess(state, file),
    terminalArtifactGrantId: file.terminalArtifactGrantId,
    // Only an explicit reload is a user act that may start a stopped WSL distro.
    wakeWslDistro
  })
  // An owner that changed during the read makes these bytes another host's.
  acquisition?.assertCurrent()
  return result
}

/** True when the tab still names the same file on the same host as when the read started. */
export function stillSameTab(before: OpenFile): OpenFile | null {
  const live = liveTab(useAppStore.getState(), before.id)
  // A tab that became deleted, renamed or re-owned during the read keeps that state.
  return live && isSameEditorFileOperationIdentity(before, live) && isEditorReloadEligible(live)
    ? live
    : null
}
