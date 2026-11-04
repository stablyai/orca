import { getRelativePathInsideRoot } from '@/lib/path'
import { splitPathSegments } from '../../../../../../shared/cross-platform-path'

export function getExplorerDirectoryDepth(
  worktreePath: string | null,
  displayRootPath: string,
  dirPath: string
): number {
  const displayRootInsideWorkspace =
    getRelativePathInsideRoot(displayRootPath, worktreePath) !== null
  const workspaceRelative = displayRootInsideWorkspace
    ? getRelativePathInsideRoot(dirPath, worktreePath)
    : null
  const displayRelative = getRelativePathInsideRoot(dirPath, displayRootPath)
  const relativePath = workspaceRelative ?? displayRelative
  return relativePath ? splitPathSegments(relativePath).length - 1 : -1
}

/** Expanded folders a refresh reads after the displayed root, each with the depth it lists at. */
export function getExplorerRefreshDirs(
  worktreePath: string | null,
  displayRootPath: string,
  expanded: Iterable<string>
): { dirPath: string; depth: number }[] {
  // Why: '' is the root, already read; an expanded folder outside the displayed tree is not on screen.
  return Array.from(expanded)
    .filter((dirPath) => Boolean(getRelativePathInsideRoot(dirPath, displayRootPath)))
    .map((dirPath) => ({
      dirPath,
      depth: getExplorerDirectoryDepth(worktreePath, displayRootPath, dirPath)
    }))
}
