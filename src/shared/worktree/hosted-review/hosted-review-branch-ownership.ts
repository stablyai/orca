import type { GitPushTarget, Worktree } from '../types'
import {
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  CLEARED_HOSTED_REVIEW_SELECTION_UPDATES,
  HOSTED_REVIEW_LINK_KEYS,
  canonicalHostedReviewBranchIdentity
} from './hosted-review-links'
import type { WorktreeMeta } from '../meta-types'
import { getWorkspaceReferenceIdentity } from '../../workspace-attachments/workspace-reference-identity'
import { WORKSPACE_ATTACHMENT_NUMBER_SLOTS } from '../../workspace-attachments/workspace-attachment-legacy'

export type HostedReviewContext = Partial<
  Pick<Worktree, (typeof HOSTED_REVIEW_LINK_KEYS)[number] | 'pushTarget' | 'linkedWorkItem'>
>

type HostedReviewSelectionSignature = { links: string; source: string | null }

export type HostedReviewOwner = {
  branch: string
  selection: HostedReviewSelectionSignature
  push: string
}

function hasSelection(context: HostedReviewContext): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => context[key] != null)
}

/** The selected review's source identity; titles and status refreshes do not change it. */
function hostedReviewSelectionSignature(
  context: HostedReviewContext
): HostedReviewSelectionSignature {
  const item = context.linkedWorkItem
  const source =
    item &&
    WORKSPACE_ATTACHMENT_NUMBER_SLOTS.some(
      ([slot, provider, type]) =>
        type !== 'issue' &&
        item.provider === provider &&
        item.type === type &&
        context[slot] === item.number
    )
      ? getWorkspaceReferenceIdentity(item)
      : null
  return {
    links: JSON.stringify(HOSTED_REVIEW_LINK_KEYS.map((key) => context[key] ?? null)),
    source
  }
}

/** Push destination identity; `remoteCreated` is operational enrichment, not a new target. */
function hostedReviewPushSignature(pushTarget: GitPushTarget | undefined): string {
  return pushTarget
    ? JSON.stringify([pushTarget.remoteName, pushTarget.branchName, pushTarget.remoteUrl ?? null])
    : ''
}

export function branchHostedReviewOwner(
  branch: string,
  context: HostedReviewContext
): HostedReviewOwner {
  return {
    branch: canonicalHostedReviewBranchIdentity(branch),
    selection: hostedReviewSelectionSignature(context),
    push: hostedReviewPushSignature(context.pushTarget)
  }
}

export type HostedReviewClearUpdates = Partial<
  Pick<WorktreeMeta, (typeof HOSTED_REVIEW_LINK_KEYS)[number] | 'pushTarget'>
>

// Detaching preserves ownership; only a different attached branch can clear unchanged links.
export function hostedReviewClearUpdates(
  owner: HostedReviewOwner | undefined,
  branch: string,
  context: HostedReviewContext
): HostedReviewClearUpdates | null {
  if (!owner || branch === '' || owner.branch === canonicalHostedReviewBranchIdentity(branch)) {
    return null
  }
  const selected = hasSelection(context)
  const pushed = context.pushTarget !== undefined
  const selection = hostedReviewSelectionSignature(context)
  const clearSelection =
    selected &&
    selection.links === owner.selection.links &&
    // Missing review source data (for example, a linked issue) does not prove a relink.
    (!selection.source || !owner.selection.source || selection.source === owner.selection.source)
  const clearPush = pushed && hostedReviewPushSignature(context.pushTarget) === owner.push
  if (!clearSelection && !clearPush) {
    return null
  }
  if ((clearSelection || !selected) && (clearPush || !pushed)) {
    return CLEARED_HOSTED_REVIEW_LINK_UPDATES
  }
  return clearSelection ? CLEARED_HOSTED_REVIEW_SELECTION_UPDATES : { pushTarget: undefined }
}
