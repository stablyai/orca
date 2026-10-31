import { SettledBodyDemandTree } from './agent-session-settled-body-demand-tree'

type Member<T> = { value: T; order: number; bytes: number }
type Lane<T> = {
  running: boolean
  items: Map<T, Member<T>>
  tree: SettledBodyDemandTree<Member<T>>
  indexed: number | null
}

// Membership belongs to selected entries; owner availability changes only its global summary.
export class SettledBodyDemand<T> {
  private readonly operations = {
    indexSteps: 0,
    candidateExaminations: 0,
    headUpdates: 0,
    ownerGroups: 0,
    queueOperations: 0,
    drainRequests: 0,
    drainRuns: 0
  }
  private readonly tree = new SettledBodyDemandTree<Lane<T>>(this.operations)
  private readonly membership = new Map<T, Lane<T>>()
  private groups = 0
  private order = 0
  private drainQueued = false
  schedule(work: () => void): void {
    this.operations.drainRequests++
    if (this.drainQueued) {
      return
    }
    this.drainQueued = true
    queueMicrotask(() => {
      this.operations.drainRuns++
      this.drainQueued = false
      work()
    })
  }
  get size(): number {
    return this.membership.size
  }
  createLane(): Lane<T> {
    return {
      running: false,
      items: new Map(),
      tree: new SettledBodyDemandTree(this.operations),
      indexed: null
    }
  }
  evidence() {
    return {
      ...this.operations,
      indexed: this.tree.size,
      groups: this.groups,
      pending: this.size,
      metadataBytes: this.size * (128 + 96) + this.groups * 160 + this.tree.size * 224
    }
  }
  private unindex(lane: Lane<T>): void {
    if (lane.indexed !== null) {
      this.tree.delete(lane.indexed)
      lane.indexed = null
    }
  }
  private index(lane: Lane<T>): void {
    this.operations.headUpdates++
    const first = lane.items.values().next().value
    if (!lane.running && first) {
      this.tree.add(lane, first.order, lane.tree.minimum)
      lane.indexed = first.order
    }
  }
  add(value: T, lane: Lane<T>, bytes: number): void {
    this.operations.queueOperations++
    if (this.membership.has(value)) {
      return
    }
    this.unindex(lane)
    const member = { value, order: ++this.order, bytes }
    if (lane.items.size === 0) {
      this.groups++
    }
    lane.items.set(value, member)
    lane.tree.add(member, member.order, bytes)
    this.membership.set(value, lane)
    this.index(lane)
  }
  delete(value: T): void {
    this.operations.queueOperations++
    const lane = this.membership.get(value)
    const member = lane?.items.get(value)
    if (!lane || !member) {
      return
    }
    this.unindex(lane)
    this.membership.delete(value)
    lane.items.delete(value)
    lane.tree.delete(member.order)
    if (lane.items.size === 0) {
      this.groups--
    }
    this.index(lane)
    if (this.size === 0) {
      this.order = 0
    }
  }
  setRunning(lane: Lane<T>, running: boolean): void {
    if (lane.running !== running) {
      this.operations.ownerGroups++
      this.unindex(lane)
      lane.running = running
      this.index(lane)
    }
  }
  firstFitting(bytes: number): T | null {
    const lane = this.tree.selectFitting(bytes, (owner) => {
      const fit = owner.tree.fittingRange(bytes)
      return { ...fit, value: fit.value ? owner : null }
    })
    return lane?.tree.firstFitting(bytes)?.value ?? null
  }
}
