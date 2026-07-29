import type { ClosedEditorTabSnapshot, OpenFile } from '@/store/slices/editor'

/** The fields recency reads — the shape an open tab and a closed-tab snapshot share. */
type RecentFileCandidate = Pick<
  OpenFile,
  | 'relativePath'
  | 'worktreeId'
  | 'diffSource'
  | 'branchCompare'
  | 'commitCompare'
  | 'conflict'
  | 'markdownPreviewSourceFileId'
  | 'isUntitled'
>

/** Why: recency only lists real on-disk files — diffs, conflict reviews, markdown previews and untitled drafts have no reopenable path. */
function isPlainEditorFile(file: RecentFileCandidate): boolean {
  return (
    !file.diffSource &&
    !file.branchCompare &&
    !file.commitCompare &&
    !file.conflict &&
    !file.markdownPreviewSourceFileId &&
    !file.isUntitled
  )
}

/**
 * Relative paths of the active worktree's recent files, most-recent first:
 * currently-open files ordered by true tab MRU (`mruOpenFileIds`, from the
 * Ctrl+Tab recent-tab stack), then recently-closed files, deduped and with the
 * active file excluded. Used to seed Quick Open's empty-query order, which is
 * otherwise just the file-listing walk order.
 *
 * `mruOpenFileIds` holds OpenFile ids ordered most-recent-first. Open files not
 * covered by it (e.g. when the MRU stack is unavailable for a single-tab group)
 * fall back to newest-open-first so nothing is dropped.
 */
export function recentQuickOpenPaths(params: {
  mruOpenFileIds: readonly string[]
  openFiles: readonly OpenFile[]
  recentlyClosed: readonly ClosedEditorTabSnapshot[]
  activeWorktreeId: string | null
  activeFileId: string | null
  limit?: number
}): string[] {
  const {
    mruOpenFileIds,
    openFiles,
    recentlyClosed,
    activeWorktreeId,
    activeFileId,
    limit = 10
  } = params
  if (!activeWorktreeId) {
    return []
  }

  const activeRelativePath =
    activeFileId != null
      ? (openFiles.find((file) => file.id === activeFileId)?.relativePath ?? null)
      : null

  // Only plain editor files in this worktree are reopenable recents.
  const openById = new Map(
    openFiles
      .filter((file) => file.worktreeId === activeWorktreeId && isPlainEditorFile(file))
      .map((file) => [file.id, file] as const)
  )

  const seen = new Set<string>()
  const out: string[] = []
  const pushPath = (relativePath: string): void => {
    if (relativePath !== activeRelativePath && !seen.has(relativePath)) {
      seen.add(relativePath)
      out.push(relativePath)
    }
  }

  for (const id of mruOpenFileIds) {
    const file = openById.get(id)
    if (file) {
      pushPath(file.relativePath)
    }
  }
  // Fallback for open files the MRU stack didn't cover, newest-open first.
  for (let i = openFiles.length - 1; i >= 0; i--) {
    if (openById.has(openFiles[i].id)) {
      pushPath(openFiles[i].relativePath)
    }
  }
  for (const closed of recentlyClosed) {
    if (closed.worktreeId === activeWorktreeId && isPlainEditorFile(closed)) {
      pushPath(closed.relativePath)
    }
  }

  return out.slice(0, limit)
}

/**
 * Empty-query Quick Open order: recent files first, then the rest of the file
 * listing (deduped against the recents), capped to `limit`.
 */
export function orderQuickOpenByRecency(
  recentPaths: readonly string[],
  allPaths: readonly string[],
  limit: number
): string[] {
  // Why: a recently-closed file may have been deleted on disk since; keep only
  // recents that still exist in the live listing so selecting one never opens a
  // phantom path.
  const allPathSet = new Set(allPaths)
  const validRecents = recentPaths.filter((path) => allPathSet.has(path))
  const recentSet = new Set(validRecents)
  const ordered: string[] = [...validRecents]
  for (const path of allPaths) {
    if (ordered.length >= limit) {
      break
    }
    if (!recentSet.has(path)) {
      ordered.push(path)
    }
  }
  return ordered.slice(0, limit)
}
