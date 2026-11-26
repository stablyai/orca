import { getRelativePathInsideRoot } from '@/lib/path'
import { useAppStore } from '@/store/index'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { AppState } from '@/store/types'

export type ActiveExplorerRevealTarget = {
  worktreeId: string
  filePath: string
}

type ActiveFileRevealState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeFileId'
  | 'openFiles'
  | 'activeWorkspaceExecutionHostId'
  | 'getKnownWorktreeById'
>

function isCombinedDiffSource(diffSource: OpenFile['diffSource']): boolean {
  return (
    diffSource === 'combined-all' ||
    diffSource === 'combined-uncommitted' ||
    diffSource === 'combined-branch' ||
    diffSource === 'combined-commit'
  )
}

/** Returns the filesystem path to reveal for an active editor tab, or null for non-file/outside-worktree tabs. */
export function getRevealableActiveFilePath(
  activeFile: OpenFile | null | undefined,
  worktreeId: string | null,
  worktreePath: string | null
): string | null {
  if (!activeFile || !worktreeId || !worktreePath) {
    return null
  }
  if (activeFile.worktreeId !== worktreeId) {
    return null
  }
  if (
    activeFile.mode !== 'edit' &&
    activeFile.mode !== 'markdown-preview' &&
    activeFile.mode !== 'diff'
  ) {
    return null
  }
  if (activeFile.mode === 'diff' && isCombinedDiffSource(activeFile.diffSource)) {
    return null
  }
  if (!activeFile.filePath || activeFile.filePath.trim().length === 0) {
    return null
  }
  // Empty relativePath means the worktree root itself (e.g. a virtual root tab), which has no tree row.
  const relativePath = getRelativePathInsideRoot(activeFile.filePath, worktreePath)
  if (!relativePath) {
    return null
  }
  return activeFile.filePath
}

export function resolveActiveFileToRevealInExplorer(
  state: ActiveFileRevealState
): ActiveExplorerRevealTarget | null {
  const { activeWorktreeId, activeFileId, openFiles } = state
  if (!activeWorktreeId || !activeFileId) {
    return null
  }
  const worktreePath =
    state.getKnownWorktreeById(activeWorktreeId, state.activeWorkspaceExecutionHostId ?? undefined)
      ?.path ?? null
  const activeFile = openFiles.find((file) => file.id === activeFileId)
  const filePath = getRevealableActiveFilePath(activeFile, activeWorktreeId, worktreePath)
  if (!filePath) {
    return null
  }
  return { worktreeId: activeWorktreeId, filePath }
}

/** Forces Explorer -> Files and reveals the active editor file without amber flash, ignoring the auto-follow toggle. */
export function revealActiveFileInExplorer(
  state: ActiveFileRevealState & Pick<AppState, 'revealInExplorer'> = useAppStore.getState()
): boolean {
  const target = resolveActiveFileToRevealInExplorer(state)
  if (!target) {
    return false
  }
  state.revealInExplorer(target.worktreeId, target.filePath, { flash: false })
  return true
}
