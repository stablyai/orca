import type { BeadsIssueDetails, BeadsIssueRelation } from '../../../shared/beads-types'

export type BeadsRelationGroupKind = 'parent' | 'sub-issues' | 'blocked-by' | 'blocks' | 'related'

export type BeadsRelationGroup = {
  kind: BeadsRelationGroupKind
  relations: BeadsIssueRelation[]
}

const PARENT_CHILD_EDGE = 'parent-child'
const BLOCKS_EDGE = 'blocks'

const GROUP_ORDER: readonly BeadsRelationGroupKind[] = [
  'parent',
  'sub-issues',
  'blocked-by',
  'blocks',
  'related'
]

/**
 * Buckets bd edges for the detail view; only non-empty groups, in render order.
 * dependencies = issues this one points at (parent, blockers); dependents = the reverse.
 * Unrecognized dependency types land in 'related'.
 */
export function groupBeadsIssueRelations(details: BeadsIssueDetails): BeadsRelationGroup[] {
  const buckets: Record<BeadsRelationGroupKind, BeadsIssueRelation[]> = {
    parent: [],
    'sub-issues': [],
    'blocked-by': [],
    blocks: [],
    related: []
  }
  for (const relation of details.dependencies) {
    if (relation.dependencyType === PARENT_CHILD_EDGE) {
      buckets.parent.push(relation)
    } else if (relation.dependencyType === BLOCKS_EDGE) {
      buckets['blocked-by'].push(relation)
    } else {
      buckets.related.push(relation)
    }
  }
  for (const relation of details.dependents) {
    if (relation.dependencyType === PARENT_CHILD_EDGE) {
      buckets['sub-issues'].push(relation)
    } else if (relation.dependencyType === BLOCKS_EDGE) {
      buckets.blocks.push(relation)
    } else {
      buckets.related.push(relation)
    }
  }
  // Why: an unknown edge can surface the same issue from both directions; show it once.
  const seenRelated = new Set<string>()
  buckets.related = buckets.related.filter((relation) => {
    if (seenRelated.has(relation.id)) {
      return false
    }
    seenRelated.add(relation.id)
    return true
  })
  return GROUP_ORDER.filter((kind) => buckets[kind].length > 0).map((kind) => ({
    kind,
    relations: buckets[kind]
  }))
}
