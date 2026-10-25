import type { TabGroup } from './tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { collectTabGroupLayoutGroupIds } from './workspace-layout/tab-group-moves'
import { pruneGroupLayout } from './workspace-session-terminal-tab-close'

function changedTabOrder(
  current: readonly string[],
  before: readonly string[],
  after: readonly string[]
): string[] {
  const retained = new Set(after)
  const removed = new Set(before.filter((id) => !retained.has(id)))
  const result = current.filter((id) => !removed.has(id))
  for (const [index, id] of after.entries()) {
    if (result.includes(id)) {
      continue
    }
    const preceding = after.slice(0, index).findLast((candidate) => result.includes(candidate))
    result.splice(preceding ? result.indexOf(preceding) + 1 : 0, 0, id)
  }
  const original = new Set(before)
  const commonBefore = before.filter((id) => retained.has(id))
  const commonAfter = after.filter((id) => original.has(id))
  if (commonBefore.every((id, index) => id === commonAfter[index])) {
    return result
  }
  const selected = after.filter((id) => result.includes(id))
  let index = 0
  return result.map((id) => (retained.has(id) ? selected[index++]! : id))
}

export function preserveConcurrentTabGroupOrder(
  stored: WorkspaceSessionState,
  baseline: WorkspaceSessionState,
  incoming: WorkspaceSessionState,
  merged: WorkspaceSessionState
): WorkspaceSessionState {
  const groupsByWorktree = { ...merged.tabGroups }
  const layouts = { ...merged.tabGroupLayouts }
  for (const [key, groups] of Object.entries(groupsByWorktree)) {
    const current = new Map(stored.tabGroups?.[key]?.map((group) => [group.id, group]))
    const before = new Map(baseline.tabGroups?.[key]?.map((group) => [group.id, group]))
    const after = new Map(incoming.tabGroups?.[key]?.map((group) => [group.id, group]))
    groupsByWorktree[key] = groups.map((group): TabGroup => {
      const previous = before.get(group.id)
      const latest = current.get(group.id)
      const next = after.get(group.id)
      if (!latest || !previous || !next) {
        return group
      }
      return {
        ...group,
        tabOrder: changedTabOrder(latest.tabOrder, previous.tabOrder, next.tabOrder)
      }
    })
    const validGroups = new Set(groups.map((group) => group.id))
    let root = pruneGroupLayout(layouts[key], validGroups)
    const shown = collectTabGroupLayoutGroupIds(root)
    for (const group of groups) {
      if (shown.has(group.id)) {
        continue
      }
      const leaf = { type: 'leaf', groupId: group.id } as const
      root = root
        ? { type: 'split', direction: 'horizontal', ratio: 0.5, first: root, second: leaf }
        : leaf
      shown.add(group.id)
    }
    if (root) {
      layouts[key] = root
    } else {
      delete layouts[key]
    }
  }
  return { ...merged, tabGroups: groupsByWorktree, tabGroupLayouts: layouts }
}
