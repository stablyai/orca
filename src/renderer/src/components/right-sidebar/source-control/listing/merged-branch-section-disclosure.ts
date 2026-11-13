import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  getAuthoritativelyRemovedWorktreeIds,
  subscribeToAuthoritativeWorktreeRemovals
} from '@/store/slices/worktrees/listing/authoritative-worktree-removal-memory'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
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

/** A known non-merged review clears the proof; a missing review or HEAD keeps it unless HEAD has moved. */
export function resolveMergedBranchProof(
  last: MergedBranchProof | null,
  review: MergedBranchSectionReview | null,
  statusHeadOid: string | null
): MergedBranchProof | null {
  if (review && review.state !== 'merged') {
    return null
  }
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
  return last?.headOid === head ? last : null
}

/** Collapses once when the workspace first reads as safe to delete; reopens only what it closed. */
export function stepMergedBranchSection(
  record: MergedBranchSectionRecord,
  observation: MergedBranchSectionObservation
): { record: MergedBranchSectionRecord; action: 'collapse' | 'expand' | null } {
  const head = normalizeOid(observation.statusHeadOid)
  // A positively resolved open or closed review outranks an unknown HEAD.
  const reviewNotMerged = observation.review !== null && observation.review.state !== 'merged'
  if (!head && !reviewNotMerged) {
    return { record, action: null }
  }
  const merged = resolveMergedBranchProof(record.merged, observation.review, head)
  let disclosure = record.disclosure
  let action: 'collapse' | 'expand' | null = null
  if (disclosure.kind === 'auto-collapsed') {
    if (reviewNotMerged || (head !== null && head !== disclosure.headOid)) {
      disclosure = { kind: 'auto-released' }
      action = 'expand'
    }
  } else if (
    head !== null &&
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

// Session-only: a restart starts fresh. Records are dropped only on positive proof that their checkout
// is gone, so neither a count cap nor a disconnected host can forget a choice and collapse again.
const MIN_PRUNE_THRESHOLD = 512
let pruneThreshold = MIN_PRUNE_THRESHOLD
const recordsByOwner = new Map<
  string,
  { owner: MergedBranchSectionOwner; record: MergedBranchSectionRecord }
>()

function isCheckoutPositivelyGone(
  owner: MergedBranchSectionOwner,
  liveInstancesByHostIdentity: ReadonlyMap<string, ReadonlySet<string | null>>,
  liveRepoIds: ReadonlySet<string>
): boolean {
  const liveInstances = liveInstancesByHostIdentity.get(getWorktreeHostIdentity(owner))
  if (liveInstances) {
    // The host reports this workspace under another checkout, so this one was recreated.
    return !liveInstances.has(owner.instanceId ?? null)
  }
  // Removing a project, or unpairing its host, removes the repo; a disconnected host keeps it.
  if (!liveRepoIds.has(getRepoIdFromWorktreeId(owner.id))) {
    return true
  }
  if (owner.hostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  // Remote rows can vanish from a partial listing; only an authoritative removal proves deletion.
  return owner.hostId !== undefined
    ? (getAuthoritativelyRemovedWorktreeIds(owner.hostId)?.has(owner.id) ?? false)
    : false
}

function pruneRecordsOfRemovedCheckouts(keep: string): void {
  const state = useAppStore.getState()
  const liveRepoIds = new Set(state.repos.map((repo) => repo.id))
  const liveInstancesByHostIdentity = new Map<string, Set<string | null>>()
  for (const worktrees of Object.values(selectWorktreesByRepo(state) ?? {})) {
    for (const worktree of worktrees) {
      const hostIdentity = getWorktreeHostIdentity(worktree)
      const instances = liveInstancesByHostIdentity.get(hostIdentity) ?? new Set<string | null>()
      instances.add(worktree.instanceId ?? null)
      liveInstancesByHostIdentity.set(hostIdentity, instances)
    }
  }
  for (const [key, entry] of recordsByOwner) {
    if (
      key !== keep &&
      isCheckoutPositivelyGone(entry.owner, liveInstancesByHostIdentity, liveRepoIds)
    ) {
      recordsByOwner.delete(key)
    }
  }
  // Doubling the bar keeps scans amortized O(1) per write when most records must stay.
  pruneThreshold = Math.max(MIN_PRUNE_THRESHOLD, recordsByOwner.size * 2)
}

function dropRecordsOfRemovedCheckouts(
  hostId: ExecutionHostId,
  worktreeIds: readonly string[]
): void {
  if (recordsByOwner.size === 0) {
    return
  }
  const removed = new Set(worktreeIds.map((id) => composeWorktreeHostIdentity(hostId, id)))
  for (const [key, entry] of recordsByOwner) {
    if (removed.has(getWorktreeHostIdentity(entry.owner))) {
      recordsByOwner.delete(key)
    }
  }
}

// Subscribed on first write: removals are dropped as they are proven, unbounded by the removal memory.
let subscribedToRemovals = false

export function readMergedBranchSectionRecord(
  owner: MergedBranchSectionOwner
): MergedBranchSectionRecord {
  return recordsByOwner.get(mergedBranchSectionOwnerKey(owner))?.record ?? UNTOUCHED_RECORD
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
  if (!subscribedToRemovals) {
    subscribedToRemovals = true
    subscribeToAuthoritativeWorktreeRemovals(dropRecordsOfRemovedCheckouts)
  }
  recordsByOwner.set(key, {
    owner: { id: owner.id, hostId: owner.hostId, instanceId: owner.instanceId },
    record
  })
  if (recordsByOwner.size > pruneThreshold) {
    pruneRecordsOfRemovedCheckouts(key)
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
