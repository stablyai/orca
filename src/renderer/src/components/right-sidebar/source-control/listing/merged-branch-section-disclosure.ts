import { useAppStore } from '@/store'
import { getWorktreeLookupIndex } from '@/store/github/refresh/worktree-refresh'
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
    !observation.branchDiffEditorActive &&
    resolveMergedReviewWorkspaceReadiness({
      review: observation.review,
      headOid: head,
      uncommittedCount: observation.uncommittedCount
    })?.kind === 'safe-to-delete'
  ) {
    disclosure = { kind: 'auto-collapsed', headOid: head }
    action = 'collapse'
  }
  if (merged === record.merged && disclosure === record.disclosure) {
    return { record, action: null }
  }
  return { record: { merged, disclosure }, action }
}

// Session-only: a restart starts fresh. Records are dropped only for workspaces that no longer exist,
// so a count cap can never forget a live workspace's choice and collapse it again.
const RECORD_PRUNE_THRESHOLD = 512
const recordsByWorktree = new Map<string, MergedBranchSectionRecord>()

export function readMergedBranchSectionRecord(worktreeId: string): MergedBranchSectionRecord {
  return recordsByWorktree.get(worktreeId) ?? UNTOUCHED_RECORD
}

export function writeMergedBranchSectionRecord(
  worktreeId: string,
  record: MergedBranchSectionRecord
): void {
  if (record.merged === null && record.disclosure.kind === 'untouched') {
    recordsByWorktree.delete(worktreeId)
    return
  }
  recordsByWorktree.set(worktreeId, record)
  if (recordsByWorktree.size > RECORD_PRUNE_THRESHOLD) {
    const liveWorktreeIds = getWorktreeLookupIndex(useAppStore.getState()).byId
    for (const id of recordsByWorktree.keys()) {
      if (id !== worktreeId && !liveWorktreeIds.has(id)) {
        recordsByWorktree.delete(id)
      }
    }
  }
}

export function markBranchSectionToggledByUser(worktreeId: string): void {
  writeMergedBranchSectionRecord(worktreeId, {
    ...readMergedBranchSectionRecord(worktreeId),
    disclosure: { kind: 'user' }
  })
}

export function isBranchSectionAutoCollapsed(worktreeId: string): boolean {
  return readMergedBranchSectionRecord(worktreeId).disclosure.kind === 'auto-collapsed'
}
