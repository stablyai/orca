import type { DiffSource } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { getRelativePathInsideRoot } from '@/lib/path'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { getBrowserPageRuntimeEnvironmentId } from '@/components/browser-pane/describe-page/browser-page-url-display'
import { browserFileUrlToAbsolutePath } from '@/components/browser-pane/describe-page/browser-artifact-upload'
import { canOpenBrowserFileInWorkspaceEditor } from '@/components/browser-pane/navigate/browser-file-editor-open'

const EMPTY_OPEN_ROW_KEYS: ReadonlySet<string> = new Set()

const SIGNATURE_SEPARATOR = '::'

export function getActiveOpenFileSignature(
  state: AppState,
  worktreeId: string | null,
  worktreePath: string | null
): string | null {
  if (!worktreeId) {
    return null
  }
  if (state.activeTabTypeByWorktree?.[worktreeId] === 'editor') {
    const activeFileId = state.activeFileIdByWorktree?.[worktreeId]
    const activeFile = state.openFiles?.find(
      (file) => file.id === activeFileId && file.worktreeId === worktreeId
    )
    return activeFile
      ? buildActiveOpenFileSignature(activeFile.diffSource, activeFile.relativePath)
      : null
  }
  if (state.activeTabTypeByWorktree?.[worktreeId] !== 'browser') {
    return null
  }
  const workspaceId = state.activeBrowserTabIdByWorktree?.[worktreeId]
  const workspace = state.browserTabsByWorktree?.[worktreeId]?.find((tab) => tab.id === workspaceId)
  const pages = workspaceId ? state.browserPagesByWorkspace?.[workspaceId] : undefined
  const page = pages?.find((candidate) => candidate.id === workspace?.activePageId) ?? pages?.[0]
  if (!page) {
    return null
  }
  let filePath: string | null = null
  if (page.docLocation?.worktreeId === worktreeId) {
    filePath = page.docLocation.filePath
  } else if (
    !page.docLocation &&
    !getBrowserPageRuntimeEnvironmentId(page, runtimeEnvironmentIdUnlessTwin(state, worktreeId)) &&
    canOpenBrowserFileInWorkspaceEditor(state, worktreeId)
  ) {
    filePath = browserFileUrlToAbsolutePath(page.url)
  }
  const relativePath = filePath ? getRelativePathInsideRoot(filePath, worktreePath) : null
  return relativePath ? buildActiveOpenFileSignature(undefined, relativePath) : null
}

/**
 * Build the stable string that identifies the active editor file for highlight
 * matching: `${diffSource}::${relativePath}`. Kept as a primitive so the zustand
 * selector that produces it stays referentially stable across unrelated store
 * updates.
 */
export function buildActiveOpenFileSignature(
  diffSource: DiffSource | undefined,
  relativePath: string
): string {
  return `${diffSource ?? 'edit'}${SIGNATURE_SEPARATOR}${relativePath}`
}

/**
 * Expand an active-open-file signature into the `${area}::${path}` row keys used
 * by the Source Control tree/list. Staged/unstaged diffs match their side; plain
 * edit tabs prefer working-tree rows and fall back to staged-only rows.
 */
export function buildActiveOpenRowKeys(
  signature: string | null,
  availableRowKeys?: ReadonlySet<string>
): ReadonlySet<string> {
  if (!signature) {
    return EMPTY_OPEN_ROW_KEYS
  }

  const separatorIndex = signature.indexOf(SIGNATURE_SEPARATOR)
  if (separatorIndex === -1) {
    return EMPTY_OPEN_ROW_KEYS
  }

  const diffSource = signature.slice(0, separatorIndex)
  const path = signature.slice(separatorIndex + SIGNATURE_SEPARATOR.length)
  if (path.length === 0) {
    return EMPTY_OPEN_ROW_KEYS
  }

  if (diffSource === 'staged') {
    return filterAvailableRowKeys([`staged::${path}`], availableRowKeys)
  }

  const workingTreeKeys = [`unstaged::${path}`, `untracked::${path}`]
  if (diffSource === 'unstaged') {
    return filterAvailableRowKeys(workingTreeKeys, availableRowKeys)
  }

  if (diffSource === 'edit') {
    const availableWorkingTreeKeys = filterAvailableRowKeys(workingTreeKeys, availableRowKeys)
    if (availableWorkingTreeKeys.size > 0 || !availableRowKeys) {
      return availableWorkingTreeKeys
    }
    return filterAvailableRowKeys([`staged::${path}`], availableRowKeys)
  }

  return EMPTY_OPEN_ROW_KEYS
}

function filterAvailableRowKeys(
  candidates: string[],
  availableRowKeys: ReadonlySet<string> | undefined
): ReadonlySet<string> {
  if (!availableRowKeys) {
    return new Set(candidates)
  }
  const keys = candidates.filter((key) => availableRowKeys.has(key))
  return keys.length > 0 ? new Set(keys) : EMPTY_OPEN_ROW_KEYS
}
