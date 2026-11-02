import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import { getActiveWorkspaceReviewKey } from './worktree-attachment-editing'
import { getWorkspaceReferenceRequest } from './workspace-reference-details'
import { canReadWorkspaceReferenceReview } from './workspace-reference-review-source'

export function getDetachedWorkspaceReviewRequest(workspace: Worktree, repo?: Repo) {
  const branch = workspace.branch.replace(/^refs\/heads\//, '').trim()
  if (!repo || (branch && branch !== 'HEAD')) {
    return null
  }
  const selectedKey = getActiveWorkspaceReviewKey(workspace)
  const item = getWorkspaceAttachments(workspace).find(
    (attachment) => getWorkspaceAttachmentKey(attachment) === selectedKey
  )
  if (!item) {
    return null
  }
  const request = getWorkspaceReferenceRequest(item, workspace, repo)
  return canReadWorkspaceReferenceReview(request) ? request : null
}
