import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

// Why: automatic stale-link clears must only unselect the review; a null legacy slot alone also deletes the item from linkedItems, losing references added via `orca reference add`.
export function buildUnselectLinkedReviewUpdate(
  worktree: Parameters<typeof getWorkspaceAttachments>[0]
): Partial<WorktreeMeta> {
  return {
    linkedPR: null,
    linkedGitLabMR: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedItems: getWorkspaceAttachments(worktree)
  }
}
