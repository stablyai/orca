import { linkOf, type Keyed } from './keyed-record-transitions'
import {
  tabRowChangesForSnapshot,
  type TabRowChange,
  type TabRowChanges
} from './keyed-tab-row-diff'

export type { TabRowChange } from './keyed-tab-row-diff'

type Row = { id: string }

/** Only changed row references survive the writer's existing diff; unavailable histories resync. */
export function readTabRowChanges<T extends Row>(
  next: Readonly<Record<string, readonly T[]>>,
  previous: Readonly<Record<string, readonly T[]>>
): TabRowChanges<T> | 'unknown' | null {
  if (next === previous) {
    return null
  }
  const steps: TabRowChanges<Row>[] = []
  let current: Keyed = next
  for (let depth = 0; ; depth++) {
    const link = linkOf(current)
    const changes = tabRowChangesForSnapshot(current)
    if (depth === 64 || !link || 'reason' in link || !changes || changes === 'unknown') {
      return 'unknown'
    }
    steps.push(changes)
    const before = link.previous.deref()
    if (!before) {
      return 'unknown'
    }
    if (before === previous) {
      break
    }
    current = before
  }
  const composed = new Map<string, Map<string, TabRowChange<T>>>()
  for (const step of steps.toReversed()) {
    for (const [workspaceId, changes] of step) {
      let bucket = composed.get(workspaceId)
      if (!bucket) {
        composed.set(workspaceId, (bucket = new Map()))
      }
      for (const [tabId, untypedChange] of changes) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the net endpoints belong to the supplied T snapshots.
        const change = untypedChange as TabRowChange<T>
        const earlier = bucket.get(tabId)
        // Reinsertion may change which duplicate entity owns the assignment.
        if (earlier && earlier.after === undefined && change.after !== undefined) {
          return 'unknown'
        }
        bucket.set(tabId, { before: earlier ? earlier.before : change.before, after: change.after })
      }
    }
  }
  return composed
}
