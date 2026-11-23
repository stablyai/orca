import type { NestedRepoScanResult } from './project-group-types'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../file-access/cross-platform-path'

/** The enclosing repository root when the scanned folder sits below it, else null. */
export function enclosingGitRootOfChildFolder(
  scan: Pick<NestedRepoScanResult, 'selectedPath' | 'selectedPathKind' | 'gitRootPath'>
): string | null {
  const root = scan.gitRootPath
  if (scan.selectedPathKind !== 'git_repo' || !root) {
    return null
  }
  if (
    normalizeRuntimePathForComparison(root) === normalizeRuntimePathForComparison(scan.selectedPath)
  ) {
    return null
  }
  // Symlinked or unrelated roots keep the default repository registration.
  return isPathInsideOrEqual(root, scan.selectedPath) ? root : null
}
