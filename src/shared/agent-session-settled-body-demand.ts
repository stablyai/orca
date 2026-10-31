import { SettledBodyDemandTree } from './agent-session-settled-body-demand-tree'

type Lane<T> = { running: boolean; groups: Map<number, Group<T>> }
type Group<T> = { lane: Lane<T>; bytes: number; items: Map<T, number>; head: number | null }

// One indexed head per exact owner/charge; the selected entries remain the only demand owner.
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
  private readonly tree = new SettledBodyDemandTree<T>(this.operations)
  private readonly membership = new Map<T, Group<T>>()
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
    return { running: false, groups: new Map() }
  }
  evidence() {
    return {
      ...this.operations,
      indexed: this.tree.size,
      groups: this.groups,
      pending: this.size,
      metadataBytes: this.size * 128 + this.groups * 160 + this.tree.size * 96
    }
  }
  private unindex(group: Group<T>): void {
    if (group.head !== null) {
      this.tree.delete(group.head)
      group.head = null
    }
  }
  private index(group: Group<T>): void {
    this.operations.headUpdates++
    if (group.lane.running) {
      return
    }
    const head = group.items.entries().next().value
    if (head) {
      this.operations.candidateExaminations++
      this.tree.add(head[0], head[1], group.bytes)
      group.head = head[1]
    }
  }
  add(value: T, lane: Lane<T>, bytes: number): void {
    this.operations.queueOperations++
    if (this.membership.has(value)) {
      return
    }
    let group = lane.groups.get(bytes)
    if (!group) {
      group = { lane, bytes, items: new Map(), head: null }
      lane.groups.set(bytes, group)
      this.groups++
    }
    group.items.set(value, ++this.order)
    this.membership.set(value, group)
    if (group.items.size === 1) {
      this.index(group)
    }
  }
  delete(value: T): void {
    this.operations.queueOperations++
    const group = this.membership.get(value)
    if (!group) {
      return
    }
    const order = group.items.get(value)
    const head = group.items.values().next().value
    this.operations.candidateExaminations++
    this.membership.delete(value)
    group.items.delete(value)
    if (order === head) {
      this.unindex(group)
      this.index(group)
    }
    if (group.items.size === 0) {
      group.lane.groups.delete(group.bytes)
      this.groups--
    }
    if (this.size === 0) {
      this.order = 0
    }
  }
  setRunning(lane: Lane<T>, running: boolean): void {
    if (lane.running === running) {
      return
    }
    lane.running = running
    for (const group of lane.groups.values()) {
      this.operations.ownerGroups++
      if (running) {
        this.unindex(group)
      } else {
        this.index(group)
      }
    }
  }
  firstFitting(bytes: number): T | null {
    return this.tree.firstFitting(bytes)
  }
}
