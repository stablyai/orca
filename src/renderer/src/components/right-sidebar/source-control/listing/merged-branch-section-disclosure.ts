import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  mergedReviewIncludesHead,
  resolveMergedReviewWorkspaceReadiness
} from '../../../../../../shared/source-control/decisions/merged-review-workspace-readiness'

export type MergedBranchSectionReview = Pick<
  HostedReviewInfo,
  'provider' | 'number' | 'state' | 'headSha' | 'confirmedContainedHeadOid'
>

/** The merged review last proven to include HEAD. */
export type MergedBranchProof = Pick<HostedReviewInfo, 'provider' | 'number'> & { headOid: string }

type BranchDisclosureOwner =
  | { kind: 'untouched' }
  | { kind: 'user' }
  | { kind: 'auto-collapsed'; headOid: string }
  | { kind: 'auto-released' }

export type MergedBranchSectionRecord = {
  /** Kept while a read is unknown, so a refresh gap does not hide the chip. */
  merged: MergedBranchProof | null
  disclosure: BranchDisclosureOwner
}

export type MergedBranchSectionObservation = {
  review: MergedBranchSectionReview | null
  /** HEAD from the latest successful status read; null while unknown. */
  statusHeadOid: string | null
  uncommittedCount: number
  isMainWorktree: boolean
  branchDiffEditorActive: boolean
}

const UNTOUCHED_RECORD: MergedBranchSectionRecord = {
  merged: null,
  disclosure: { kind: 'untouched' }
}

function normalizeOid(oid: string | null | undefined): string | null {
  const normalized = oid?.trim().toLowerCase() ?? ''
  return normalized.length > 0 ? normalized : null
}

/** A missing review or HEAD read keeps the last proof unless a known HEAD has moved past it. */
export function resolveMergedBranchProof(
  last: MergedBranchProof | null,
  review: MergedBranchSectionReview | null,
  statusHeadOid: string | null
): MergedBranchProof | null {
  const head = normalizeOid(statusHeadOid)
  if (!head) {
    return last
  }
  if (review?.state === 'merged') {
    if (!mergedReviewIncludesHead(review, head)) {
      return null
    }
    return last?.headOid === head &&
      last.provider === review.provider &&
      last.number === review.number
      ? last
      : { provider: review.provider, number: review.number, headOid: head }
  }
  if (review) {
    return null
  }
  return last?.headOid === head ? last : null
}

/** Collapses once when the workspace first reads as safe to delete; reopens only what it closed. */
export function stepMergedBranchSection(
  record: MergedBranchSectionRecord,
  observation: MergedBranchSectionObservation
): { record: MergedBranchSectionRecord; action: 'collapse' | 'expand' | null } {
  const head = normalizeOid(observation.statusHeadOid)
  if (!head) {
    return { record, action: null }
  }
  const merged = resolveMergedBranchProof(record.merged, observation.review, head)
  let disclosure = record.disclosure
  let action: 'collapse' | 'expand' | null = null
  if (disclosure.kind === 'auto-collapsed') {
    const reviewNoLongerMerged =
      observation.review !== null && observation.review.state !== 'merged'
    if (head !== disclosure.headOid || reviewNoLongerMerged) {
      disclosure = { kind: 'auto-released' }
      action = 'expand'
    }
  } else if (
    disclosure.kind === 'untouched' &&
    !observation.isMainWorktree &&
    resolveMergedReviewWorkspaceReadiness({
      review: observation.review,
      headOid: head,
      uncommittedCount: observation.uncommittedCount
    })?.kind === 'safe-to-delete'
  ) {
    // A diff the user is reading from this section wins for the rest of the session.
    if (observation.branchDiffEditorActive) {
      disclosure = { kind: 'auto-released' }
    } else {
      disclosure = { kind: 'auto-collapsed', headOid: head }
      action = 'collapse'
    }
  }
  if (merged === record.merged && disclosure === record.disclosure) {
    return { record, action: null }
  }
  return { record: { merged, disclosure }, action }
}

/** One host's copy of a workspace in one checkout lifetime; a recreated workspace starts fresh. */
export type MergedBranchSectionOwner = Pick<Worktree, 'id' | 'hostId' | 'instanceId'>

export function mergedBranchSectionOwnerKey(owner: MergedBranchSectionOwner): string {
  return JSON.stringify([getWorktreeHostIdentity(owner), owner.instanceId ?? null])
}

// Session-only: a restart starts fresh. Records are dropped only for workspaces that no longer exist,
// so a count cap can never forget a live workspace's choice and collapse it again.
const MIN_PRUNE_THRESHOLD = 512
let pruneThreshold = MIN_PRUNE_THRESHOLD
const recordsByOwner = new Map<string, MergedBranchSectionRecord>()

function pruneRecordsOfRemovedWorkspaces(keep: string): void {
  const live = new Set<string>()
  for (const worktrees of Object.values(selectWorktreesByRepo(useAppStore.getState()) ?? {})) {
    for (const worktree of worktrees) {
      live.add(mergedBranchSectionOwnerKey(worktree))
    }
  }
  for (const key of recordsByOwner.keys()) {
    if (key !== keep && !live.has(key)) {
      recordsByOwner.delete(key)
    }
  }
  // Doubling the bar keeps scans amortized O(1) per write when most records belong to live workspaces.
  pruneThreshold = Math.max(MIN_PRUNE_THRESHOLD, recordsByOwner.size * 2)
}

export function readMergedBranchSectionRecord(
  owner: MergedBranchSectionOwner
): MergedBranchSectionRecord {
  return recordsByOwner.get(mergedBranchSectionOwnerKey(owner)) ?? UNTOUCHED_RECORD
}

export function writeMergedBranchSectionRecord(
  owner: MergedBranchSectionOwner,
  record: MergedBranchSectionRecord
): void {
  const key = mergedBranchSectionOwnerKey(owner)
  if (record.merged === null && record.disclosure.kind === 'untouched') {
    recordsByOwner.delete(key)
    return
  }
  recordsByOwner.set(key, record)
  if (recordsByOwner.size > pruneThreshold) {
    pruneRecordsOfRemovedWorkspaces(key)
  }
}

export function markBranchSectionToggledByUser(owner: MergedBranchSectionOwner): void {
  writeMergedBranchSectionRecord(owner, {
    ...readMergedBranchSectionRecord(owner),
    disclosure: { kind: 'user' }
  })
}

export function isBranchSectionAutoCollapsed(owner: MergedBranchSectionOwner): boolean {
  return readMergedBranchSectionRecord(owner).disclosure.kind === 'auto-collapsed'
}
