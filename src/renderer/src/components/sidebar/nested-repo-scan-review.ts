import type { NestedRepoScanResult } from '../../../../shared/project-group-types'

export function shouldReviewNestedRepoScan(
  scan: NestedRepoScanResult,
  groupImportIntent = false
): boolean {
  if (scan.selectedPathKind === 'git_repo') {
    return groupImportIntent
  }
  return (
    groupImportIntent ||
    scan.repos.length > 0 ||
    Object.values(scan.diagnostics?.counts ?? {}).some((count) => count > 0) ||
    scan.stopped ||
    scan.timedOut ||
    scan.truncated
  )
}
