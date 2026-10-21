import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

/** Base-ref fields that still make sense on a freshly provisioned or cloned checkout. */
export function getPortableBaseSelection(
  request: WorktreeCreationRequest
): Pick<WorktreeCreationRequest, 'baseBranch' | 'compareBaseRef'> {
  const keepBaseBranch =
    request.linkedPR !== undefined ||
    request.linkedGitLabMR !== undefined ||
    request.linkedBitbucketPR !== undefined ||
    request.linkedAzureDevOpsPR !== undefined ||
    request.linkedGiteaPR !== undefined ||
    Boolean(request.compareBaseRef) ||
    Boolean(request.pushTarget) ||
    Boolean(request.branchNameOverride)
  if (keepBaseBranch) {
    return {
      ...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
      ...(request.compareBaseRef ? { compareBaseRef: request.compareBaseRef } : {})
    }
  }
  // Why: recipes and machines move the create to a fresh checkout where the source repo's
  // local branches may not exist, so the remote resolves its own default unless the user
  // picked a provider-backed start point above.
  return { baseBranch: undefined, compareBaseRef: undefined }
}
