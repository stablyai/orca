import type { BrowserPageDocLocation } from './browser-workspace-types'
import { relativePathInsideRoot, resolveRuntimePath } from './cross-platform-path'

/** Compare fields: mirrors rebuild object identity on every page update, which would otherwise republish unchanged workspace tabs. */
export function browserPageDocLocationsEqual(
  left: BrowserPageDocLocation | null,
  right: BrowserPageDocLocation | null
): boolean {
  if (left === null || right === null) {
    return left === right
  }
  return left.worktreeId === right.worktreeId && left.filePath === right.filePath
}

export function remapBrowserPageDocLocation(
  location: BrowserPageDocLocation,
  oldWorktreeId: string,
  newWorktreeId: string,
  oldWorktreePath?: string,
  newWorktreePath?: string
): BrowserPageDocLocation {
  if (location.worktreeId !== oldWorktreeId) {
    return location
  }
  const relativePath =
    oldWorktreePath && newWorktreePath
      ? relativePathInsideRoot(oldWorktreePath, location.filePath)
      : null
  return {
    ...location,
    worktreeId: newWorktreeId,
    ...(relativePath !== null && newWorktreePath
      ? { filePath: resolveRuntimePath(newWorktreePath, relativePath) }
      : {})
  }
}
