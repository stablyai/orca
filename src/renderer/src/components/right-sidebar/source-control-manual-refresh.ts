import type { DiffSource, OpenFile } from '@/store/slices/editor'

const RELOADABLE_DIFF_SOURCES: ReadonlySet<DiffSource> = new Set(['staged', 'unstaged'])

/** Skip starting a second manual refresh while one is already in flight. */
export function shouldStartManualSourceControlRefresh(isRefreshing: boolean): boolean {
  return !isRefreshing
}

/** Single-file staged/unstaged diffs owned by this worktree that should reload on manual SC refresh. */
export function isManualRefreshReloadableDiffFile(
  file: Pick<OpenFile, 'worktreeId' | 'mode' | 'diffSource'>,
  worktreeId: string
): boolean {
  return (
    file.worktreeId === worktreeId &&
    file.mode === 'diff' &&
    file.diffSource !== undefined &&
    RELOADABLE_DIFF_SOURCES.has(file.diffSource)
  )
}

export function bumpDiffContentReloadNonce<T extends { diffContentReloadNonce?: number }>(
  file: T
): T {
  return {
    ...file,
    diffContentReloadNonce: (file.diffContentReloadNonce ?? 0) + 1
  }
}

/** Bump reload nonces for open staged/unstaged diffs so viewers refetch after a manual SC refresh. */
export function applyManualSourceControlDiffReload(
  openFiles: readonly OpenFile[],
  worktreeId: string
): OpenFile[] {
  let changed = false
  const next = openFiles.map((file) => {
    if (!isManualRefreshReloadableDiffFile(file, worktreeId)) {
      return file
    }
    changed = true
    return bumpDiffContentReloadNonce(file)
  })
  return changed ? next : (openFiles as OpenFile[])
}
