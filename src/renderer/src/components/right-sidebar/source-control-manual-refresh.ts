import type { DiffSource, EditorViewMode, OpenFile } from '@/store/slices/editor'

const RELOADABLE_DIFF_SOURCES: ReadonlySet<DiffSource> = new Set(['staged', 'unstaged'])

/** Skip starting a second manual refresh while one is already in flight. */
export function shouldStartManualSourceControlRefresh(isRefreshing: boolean): boolean {
  return !isRefreshing
}

/** Single-file staged/unstaged diffs (and edit tabs in Changes view) for this worktree. */
export function isManualRefreshReloadableDiffFile(
  file: Pick<OpenFile, 'id' | 'worktreeId' | 'mode' | 'diffSource'>,
  worktreeId: string,
  editorViewMode?: Readonly<Record<string, EditorViewMode>>
): boolean {
  if (file.worktreeId !== worktreeId) {
    return false
  }
  if (
    file.mode === 'diff' &&
    file.diffSource !== undefined &&
    RELOADABLE_DIFF_SOURCES.has(file.diffSource)
  ) {
    return true
  }
  // Why: SC opens unstaged Markdown as edit + Changes; manual refresh must still force that diff.
  return file.mode === 'edit' && editorViewMode?.[file.id] === 'changes'
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
  worktreeId: string,
  editorViewMode?: Readonly<Record<string, EditorViewMode>>
): OpenFile[] {
  let changed = false
  const next = openFiles.map((file) => {
    if (!isManualRefreshReloadableDiffFile(file, worktreeId, editorViewMode)) {
      return file
    }
    changed = true
    return bumpDiffContentReloadNonce(file)
  })
  return changed ? next : (openFiles as OpenFile[])
}
