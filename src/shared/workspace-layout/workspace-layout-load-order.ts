// The one tab order from stored data whose three orders can disagree (written by older builds).
// Fixed precedence, no merging: group tab order, then tab-bar sortOrder, then row sortOrder, then
// creation time.

import type { TabGroup } from '../tab-types'
import type { LayoutGroup } from './workspace-layout-model'

export type OrderCandidate = {
  id: string
  /** The group the tab-bar entry names, if any. */
  groupId?: string
  tabBarSortOrder?: number
  rowSortOrder?: number
  createdAt: number
}

function compareUnplaced(left: OrderCandidate, right: OrderCandidate): number {
  const leftOrder = left.tabBarSortOrder ?? left.rowSortOrder ?? Number.POSITIVE_INFINITY
  const rightOrder = right.tabBarSortOrder ?? right.rowSortOrder ?? Number.POSITIVE_INFINITY
  return leftOrder - rightOrder || left.createdAt - right.createdAt
}

export function resolveGroupOrder(args: {
  storedGroups: readonly TabGroup[]
  candidates: readonly OrderCandidate[]
  workspaceKey: string
  mintId: (seed: string) => string
}): LayoutGroup[] {
  const known = new Set(args.candidates.map((candidate) => candidate.id))
  const placed = new Set<string>()
  const groups: LayoutGroup[] = []
  for (const stored of args.storedGroups) {
    if (groups.some((group) => group.id === stored.id)) {
      continue
    }
    const tabOrder: string[] = []
    for (const tabId of stored.tabOrder) {
      if (known.has(tabId) && !placed.has(tabId)) {
        placed.add(tabId)
        tabOrder.push(tabId)
      }
    }
    groups.push({ id: stored.id, tabOrder })
  }
  const unplaced = args.candidates.filter((candidate) => !placed.has(candidate.id))
  for (const candidate of [...unplaced].sort(compareUnplaced)) {
    let group = groups.find((entry) => entry.id === candidate.groupId) ?? groups[0]
    if (!group) {
      group = { id: args.mintId(`group:${args.workspaceKey}`), tabOrder: [] }
      groups.push(group)
    }
    group.tabOrder.push(candidate.id)
  }
  return groups.filter((group) => group.tabOrder.length > 0)
}
