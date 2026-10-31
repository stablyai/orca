import type { TabGroupLayoutNode } from '../tab-types'

type GroupOccurrence = {
  node: TabGroupLayoutNode
  start: number
  end: number
  alive: boolean
  parent?: GroupOccurrence
  first?: GroupOccurrence
  second?: GroupOccurrence
}

export class RetiringGroupLayout {
  private root?: GroupOccurrence
  private readonly leaves = new Map<string, GroupOccurrence[]>()

  constructor(root: TabGroupLayoutNode) {
    let ordinal = 0
    const index = (node: TabGroupLayoutNode, parent?: GroupOccurrence): GroupOccurrence => {
      const entry: GroupOccurrence = { node, parent, start: ordinal++, end: 0, alive: true }
      if (node.type === 'leaf') {
        const entries = this.leaves.get(node.groupId) ?? []
        entries.push(entry)
        this.leaves.set(node.groupId, entries)
      } else {
        entry.first = index(node.first, entry)
        entry.second = index(node.second, entry)
      }
      entry.end = ordinal
      return entry
    }
    this.root = index(root)
  }

  remove(groupId: string): void {
    const candidates = new Set<GroupOccurrence>()
    for (const leaf of this.leaves.get(groupId) ?? []) {
      if (leaf.alive) {
        candidates.add(leaf.parent ?? leaf)
      }
    }
    const ordered = this.order([...candidates])
    let suppressedUntil = -1
    const frontier: GroupOccurrence[] = []
    for (const candidate of ordered) {
      if (candidate.start >= suppressedUntil) {
        frontier.push(candidate)
        suppressedUntil = candidate.end
      }
    }
    for (const candidate of frontier) {
      const first = candidate.first
      const second = candidate.second
      if (!first || !second) {
        candidate.alive = false
        this.root = undefined
        continue
      }
      const removeFirst = first.node.type === 'leaf' && first.node.groupId === groupId
      const removed = removeFirst ? first : second
      const sibling = removeFirst ? second : first
      removed.alive = false
      candidate.alive = false
      sibling.parent = candidate.parent
      if (!candidate.parent) {
        this.root = sibling
      } else if (candidate.parent.first === candidate) {
        candidate.parent.first = sibling
      } else {
        candidate.parent.second = sibling
      }
    }
  }

  private order(entries: GroupOccurrence[]): GroupOccurrence[] {
    let output = entries.slice()
    for (let width = 1; width < entries.length; width *= 2) {
      for (let start = 0; start < entries.length; start += width * 2) {
        const middle = Math.min(start + width, entries.length)
        const end = Math.min(start + width * 2, entries.length)
        let left = start
        let right = middle
        for (let next = start; next < end; next++) {
          output[next] =
            left < middle && (right >= end || entries[left].start <= entries[right].start)
              ? entries[left++]
              : entries[right++]
        }
      }
      const previous = entries
      entries = output
      output = previous
    }
    return entries
  }

  materialize(): TabGroupLayoutNode | undefined {
    const build = (entry: GroupOccurrence): TabGroupLayoutNode =>
      entry.node.type === 'leaf'
        ? entry.node
        : { ...entry.node, first: build(entry.first!), second: build(entry.second!) }
    return this.root && build(this.root)
  }
}
