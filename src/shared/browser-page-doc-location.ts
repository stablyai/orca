import type { BrowserPageDocLocation } from './browser-workspace-types'
import { relativePathInsideRoot, resolveRuntimePath } from './cross-platform-path'

/**
 * Why an explicit comparison and not object identity: the mirror rebuilds the workspace's copy of
 * this on every page change, so identity is never equal and the store would write a new workspace
 * object — and republish the tab — on every unrelated update.
 */
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
