import type { GitPushTarget, GitWorktreeInfo, Worktree } from './types'
import {
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  CLEARED_HOSTED_REVIEW_SELECTION_UPDATES,
  HOSTED_REVIEW_LINK_KEYS,
  canonicalHostedReviewBranchIdentity
} from './hosted-review-links'
import type { WorktreeMeta } from './meta-types'
import { getWorkspaceReferenceIdentity } from '../workspace-attachments/workspace-reference-identity'
import { WORKSPACE_ATTACHMENT_NUMBER_SLOTS } from '../workspace-attachments/workspace-attachment-legacy'

// Why: a detached HEAD (rebase, bisect, checkout of a commit) is not proof the active review
// belongs to other work. Only an attached checkout decides, against the branch that last proved
// ownership. This identity decides retention only; actions keep reading the checked-out branch.

export type HostedReviewContext = Partial<
  Pick<Worktree, (typeof HOSTED_REVIEW_LINK_KEYS)[number] | 'pushTarget' | 'linkedWorkItem'>
>

type HostedReviewSelectionSignature = { links: string; source: string | null }

export type HostedReviewOwner =
  /** A branch proved this review context; signatures record it as it stood then. */
  | { kind: 'branch'; branch: string; selection: HostedReviewSelectionSignature; push: string }
  /** Detached with no rebase in progress, verified by the owning host. */
  | { kind: 'detached'; selection: HostedReviewSelectionSignature; push: string }
  /** Detached, but no host verdict says which branch (if any) the review belongs to. */
  | { kind: 'unknown' }

export type HostedReviewClear = { selection: boolean; push: boolean }

const NO_CLEAR: HostedReviewClear = { selection: false, push: false }

function hasSelection(context: HostedReviewContext): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => context[key] != null)
}

/** The selected review's source identity; titles and status refreshes do not change it. */
export function hostedReviewSelectionSignature(
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
export function hostedReviewPushSignature(pushTarget: GitPushTarget | undefined): string {
  return pushTarget
    ? JSON.stringify([pushTarget.remoteName, pushTarget.branchName, pushTarget.remoteUrl ?? null])
    : ''
}

export function branchHostedReviewOwner(
  branch: string,
  context: HostedReviewContext
): Extract<HostedReviewOwner, { kind: 'branch' }> {
  return {
    kind: 'branch',
    branch: canonicalHostedReviewBranchIdentity(branch),
    selection: hostedReviewSelectionSignature(context),
    push: hostedReviewPushSignature(context.pushTarget)
  }
}

/** Synthesized fallback rows (disconnected SSH, stopped WSL) carry no Git observation. */
export function isUnobservedWorktreeIdentity(row: { branch: string; head?: string }): boolean {
  return row.branch === '' && row.head === ''
}

/** Ownership a detached row's host verdict proves; `previous` wins unless it is unknown. */
export function detachedHostedReviewOwner(
  row: Pick<GitWorktreeInfo, 'detachedRebase'> & HostedReviewContext,
  previous: HostedReviewOwner | undefined
): HostedReviewOwner {
  if (previous && previous.kind !== 'unknown') {
    return previous
  }
  const verdict = row.detachedRebase
  if (verdict?.active === false) {
    return {
      kind: 'detached',
      selection: hostedReviewSelectionSignature(row),
      push: hostedReviewPushSignature(row.pushTarget)
    }
  }
  if (verdict?.active && verdict.branch) {
    return branchHostedReviewOwner(verdict.branch, row)
  }
  return { kind: 'unknown' }
}

/**
 * What an attached observation of `branch` clears. Unknown ownership never clears. A part
 * changed to a newer non-empty association since the proof is kept.
 */
export function decideHostedReviewClear(
  owner: HostedReviewOwner | undefined,
  branch: string,
  context: HostedReviewContext
): HostedReviewClear {
  if (!owner || owner.kind === 'unknown' || branch === '') {
    return NO_CLEAR
  }
  const selected = hasSelection(context)
  const pushed = context.pushTarget !== undefined
  if (owner.kind === 'branch' && owner.branch === canonicalHostedReviewBranchIdentity(branch)) {
    return NO_CLEAR
  }
  const selection = hostedReviewSelectionSignature(context)
  return {
    selection:
      selected &&
      selection.links === owner.selection.links &&
      // Missing review source data (for example, a linked issue) does not prove a relink.
      (!selection.source || !owner.selection.source || selection.source === owner.selection.source),
    push: pushed && hostedReviewPushSignature(context.pushTarget) === owner.push
  }
}

/** A row's ownership before its next observation: attached branch, else its same-instance proof, else its host's verdict. */
export function currentHostedReviewOwner(
  row: Pick<GitWorktreeInfo, 'branch' | 'detachedRebase'> &
    Partial<Pick<GitWorktreeInfo, 'head'>> &
    Pick<Worktree, 'instanceId'> &
    HostedReviewContext,
  remembered: { instanceId: string | undefined; owner: HostedReviewOwner } | undefined
): HostedReviewOwner | undefined {
  if (row.branch !== '') {
    return branchHostedReviewOwner(row.branch, row)
  }
  const proven =
    remembered && remembered.instanceId === row.instanceId ? remembered.owner : undefined
  // A synthesized row is no observation: keep any proof, else this is a first sighting.
  return isUnobservedWorktreeIdentity(row) ? proven : detachedHostedReviewOwner(row, proven)
}

export type HostedReviewClearUpdates = Partial<
  Pick<WorktreeMeta, (typeof HOSTED_REVIEW_LINK_KEYS)[number] | 'pushTarget'>
>

/** The metadata write a decision makes; clearing every present part is the full branch-switch clear. */
export function hostedReviewClearUpdates(
  decision: HostedReviewClear,
  context: HostedReviewContext
): { updates: HostedReviewClearUpdates; full: boolean } | null {
  if (!decision.selection && !decision.push) {
    return null
  }
  const full =
    (decision.selection || !hasSelection(context)) &&
    (decision.push || context.pushTarget === undefined)
  if (full) {
    return { updates: CLEARED_HOSTED_REVIEW_LINK_UPDATES, full }
  }
  return {
    updates: decision.selection
      ? CLEARED_HOSTED_REVIEW_SELECTION_UPDATES
      : { pushTarget: undefined },
    full
  }
}
