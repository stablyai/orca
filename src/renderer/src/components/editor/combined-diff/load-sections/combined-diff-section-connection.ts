import { getConnectionIdForFile } from '@/lib/connection-context'
import { joinPath } from '@/lib/path'

/** Mixed local/SSH folder workspaces need child-repo path ownership to route section reads to the correct host. */
export function getCombinedDiffSectionConnectionId(
  worktreeId: string | null,
  worktreeRootPath: string,
  sectionPath: string
): string | undefined {
  return getConnectionIdForFile(worktreeId, joinPath(worktreeRootPath, sectionPath)) ?? undefined
}
