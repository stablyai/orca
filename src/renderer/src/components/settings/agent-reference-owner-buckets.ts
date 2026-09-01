// Pure classification of agent-reference owners into the three name-freeing
// buckets shown in the reference view (plan §219/§975). Node-free so it
// unit-tests without a DOM.

import type {
  AgentReferenceOwnerKind,
  AgentReferenceSummary
} from '../../../../shared/agent-reference-snapshot'

/** How a reference's name can be freed. The view never falsely promises a
 *  rebind: `rebindable` owners have a real editor where the user reselects an
 *  agent; `removable` owners are history records the user can delete; `retained`
 *  owners hold the reference until their own lifecycle ends and cannot be freed
 *  by hand. */
export type ReferenceOwnerBucket = 'rebindable' | 'removable' | 'retained'

/** Exhaustive over the owner union so a newly added owner kind fails typecheck
 *  here rather than silently defaulting into the freeable bucket. */
export function classifyReferenceOwner(owner: AgentReferenceOwnerKind): ReferenceOwnerBucket {
  switch (owner) {
    case 'default':
    case 'quick-command':
    case 'commit-message':
    case 'source-control-recipe':
    case 'automation':
      return 'rebindable'
    case 'session':
      return 'removable'
    case 'background':
    case 'orchestration':
    case 'workspace':
      return 'retained'
  }
}

export const REFERENCE_BUCKET_ORDER: readonly ReferenceOwnerBucket[] = [
  'rebindable',
  'removable',
  'retained'
]

// Stable owner order within a bucket so the grouped view never reshuffles across
// renders regardless of the host summary's array order.
const OWNER_ORDER: readonly AgentReferenceOwnerKind[] = [
  'default',
  'quick-command',
  'commit-message',
  'source-control-recipe',
  'automation',
  'session',
  'background',
  'orchestration',
  'workspace'
]

export type ReferenceOwnerRow = {
  owner: AgentReferenceOwnerKind
  /** Readable count (>= 0); 0 for an unreadable owner store, which sets `unreadable`. */
  count: number
  /** The owner store returned -1 (could not be read), so its true count is unknown. */
  unreadable: boolean
}

export type ReferenceBucketGroup = {
  bucket: ReferenceOwnerBucket
  owners: ReferenceOwnerRow[]
  /** Sum of readable owner counts in this bucket. */
  total: number
  /** At least one owner store in this bucket could not be read. */
  unreadable: boolean
}

/**
 * Group the per-owner reference summary into the three name-freeing buckets,
 * dropping zero-count owners and preserving `OWNER_ORDER`. A -1 count marks an
 * unreadable owner store: it still appears (so the reference is never silently
 * hidden) but contributes to `unreadable` rather than the total.
 */
export function groupReferencesByBucket(
  summary: readonly AgentReferenceSummary[]
): ReferenceBucketGroup[] {
  const rows: ReferenceOwnerRow[] = summary
    .filter((row) => row.count !== 0)
    .map((row) => ({
      owner: row.owner,
      count: row.count < 0 ? 0 : row.count,
      unreadable: row.count < 0
    }))
    .sort((a, b) => OWNER_ORDER.indexOf(a.owner) - OWNER_ORDER.indexOf(b.owner))

  const groups: ReferenceBucketGroup[] = []
  for (const bucket of REFERENCE_BUCKET_ORDER) {
    const owners = rows.filter((row) => classifyReferenceOwner(row.owner) === bucket)
    if (owners.length === 0) {
      continue
    }
    groups.push({
      bucket,
      owners,
      total: owners.reduce((sum, row) => sum + row.count, 0),
      unreadable: owners.some((row) => row.unreadable)
    })
  }
  return groups
}
