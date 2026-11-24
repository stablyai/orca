import type { AgentPublicIdentity } from '../../../../shared/orchestration/workers/worker-tab-stamp'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { CoordinatorTabIdentityIndex } from './coordinator-tab-identities'

export type CoordinatorWorkerRoute =
  | { kind: 'pane'; tabId: string; leafId: string }
  | { kind: 'session'; root: string }

export function coordinatorWorkerRoute(
  identity: AgentPublicIdentity | undefined
): CoordinatorWorkerRoute | null {
  if (!identity) {
    return null
  }
  if (identity.kind === 'session') {
    return { kind: 'session', root: identity.lineageRootSessionId }
  }
  const pane = parsePaneKey(identity.paneKey)
  return pane ? { kind: 'pane', tabId: pane.tabId, leafId: pane.leafId } : null
}

export type AttentionWorker = { route: CoordinatorWorkerRoute | null; needsYou: boolean }

export class CoordinatorWorkerBucket<T extends AttentionWorker> {
  readonly members = new Set<T>()
  version = 0
  needsYou = 0
  private attentionVersion = 0
  private membershipVersion = 0
  private readonly membersByLeaf = new Map<string, number>()
  private readonly needsYouByLeaf = new Map<string, number>()
  private fallback:
    | { attention: number; membership: number; identities: number; count: number; members: number }
    | undefined

  constructor(private readonly entityBucket: boolean) {}

  add(worker: T): void {
    this.members.add(worker)
    this.changeMembership(worker, 1)
    this.update(worker, worker.needsYou ? 1 : 0)
  }

  remove(worker: T): void {
    this.members.delete(worker)
    this.changeMembership(worker, -1)
    this.update(worker, worker.needsYou ? -1 : 0)
  }

  update(worker: T, attentionDelta: number): void {
    this.version++
    if (!attentionDelta) {
      return
    }
    this.needsYou += attentionDelta
    this.attentionVersion++
    if (this.entityBucket && worker.route?.kind === 'pane') {
      const leaf = worker.route.leafId
      const count = (this.needsYouByLeaf.get(leaf) ?? 0) + attentionDelta
      if (count) {
        this.needsYouByLeaf.set(leaf, count)
      } else {
        this.needsYouByLeaf.delete(leaf)
      }
    }
  }

  unresolvedNeedsYou(identities: CoordinatorTabIdentityIndex): number {
    return this.unresolved(identities).count
  }

  unresolvedMembers(identities: CoordinatorTabIdentityIndex): number {
    return this.unresolved(identities).members
  }

  private changeMembership(worker: T, delta: number): void {
    this.membershipVersion++
    if (this.entityBucket && worker.route?.kind === 'pane') {
      const leaf = worker.route.leafId
      const count = (this.membersByLeaf.get(leaf) ?? 0) + delta
      if (count) {
        this.membersByLeaf.set(leaf, count)
      } else {
        this.membersByLeaf.delete(leaf)
      }
    }
  }

  private unresolved(identities: CoordinatorTabIdentityIndex) {
    if (
      this.fallback?.attention === this.attentionVersion &&
      this.fallback.membership === this.membershipVersion &&
      this.fallback.identities === identities.revision
    ) {
      return this.fallback
    }
    let count = 0
    let members = 0
    for (const [leaf, size] of this.membersByLeaf) {
      if (!identities.byLeaf(leaf)) {
        count += this.needsYouByLeaf.get(leaf) ?? 0
        members += size
      }
    }
    this.fallback = {
      attention: this.attentionVersion,
      membership: this.membershipVersion,
      identities: identities.revision,
      count,
      members
    }
    return this.fallback
  }
}

export class CoordinatorWorkerBuckets<T extends AttentionWorker> {
  generation = 0
  readonly leaves = new Map<string, CoordinatorWorkerBucket<T>>()
  readonly entities = new Map<string, CoordinatorWorkerBucket<T>>()
  readonly sessions = new Map<string, CoordinatorWorkerBucket<T>>()

  forRoute(route: CoordinatorWorkerRoute | null): readonly CoordinatorWorkerBucket<T>[] {
    if (!route) {
      return []
    }
    if (route.kind === 'session') {
      return [this.bucket(this.sessions, route.root)]
    }
    return [this.bucket(this.leaves, route.leafId), this.bucket(this.entities, route.tabId, true)]
  }

  remove(worker: T, buckets: readonly CoordinatorWorkerBucket<T>[]): void {
    for (const bucket of buckets) {
      bucket.remove(worker)
    }
    const route = worker.route
    if (route?.kind === 'session') {
      this.prune(this.sessions, route.root)
    } else if (route) {
      this.prune(this.leaves, route.leafId)
      this.prune(this.entities, route.tabId)
    }
  }

  private prune(map: Map<string, CoordinatorWorkerBucket<T>>, key: string): void {
    if (map.get(key)?.members.size === 0) {
      map.delete(key)
      this.generation++
    }
  }

  private bucket(
    map: Map<string, CoordinatorWorkerBucket<T>>,
    key: string,
    entity = false
  ): CoordinatorWorkerBucket<T> {
    let bucket = map.get(key)
    if (!bucket) {
      bucket = new CoordinatorWorkerBucket(entity)
      map.set(key, bucket)
      this.generation++
    }
    return bucket
  }
}
