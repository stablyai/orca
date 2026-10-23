// A held tab that shows only in main's groups: drawn in a group main's frame lacks (opened to the
// side, or main closed its group), it moves into the nearest group main has, so the workspace's
// group tree stays exactly main's.

import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { collectTabGroupLayoutGroupIds } from '../../../shared/workspace-layout/tab-group-moves'

/** One workspace as the window draws it. */
export type DrawnWorkspace = {
  tabs: readonly Tab[]
  groups: readonly TabGroup[]
  tree: TabGroupLayoutNode | undefined
  activeGroupId: string | undefined
}

/** Where held tabs go: their new group, the window's groups after the move, and the tab the user
 *  was on when it moved (shown in its new group). */
export type HeldTabPlacement = {
  tabGroupIdById: ReadonlyMap<string, string>
  groups: TabGroup[]
  shownTabId: string | undefined
}

/** The subtree beside `groupId`'s leaf. */
function siblingOf(root: TabGroupLayoutNode, groupId: string): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return null
  }
  const isLeaf = (node: TabGroupLayoutNode): boolean =>
    node.type === 'leaf' && node.groupId === groupId
  if (isLeaf(root.first)) {
    return root.second
  }
  if (isLeaf(root.second)) {
    return root.first
  }
  return siblingOf(root.first, groupId) ?? siblingOf(root.second, groupId)
}

/** Main's first group under the window's sibling of `groupId`, else the active one, else main's first. */
function nearestMainGroup(
  drawn: DrawnWorkspace,
  groupId: string,
  mainIds: ReadonlySet<string>,
  fallback: string
): string {
  const sibling = drawn.tree ? siblingOf(drawn.tree, groupId) : null
  const active = drawn.activeGroupId
  return (
    [...collectTabGroupLayoutGroupIds(sibling)].find((id) => mainIds.has(id)) ??
    (active && mainIds.has(active) ? active : fallback)
  )
}

/** Each tab `inMain` names, drawn outside `mainGroups`, at the end of the nearest; null when none. */
export function heldTabsInMainGroups(
  drawn: DrawnWorkspace,
  mainGroups: readonly TabGroup[],
  inMain: (tab: Tab) => boolean
): HeldTabPlacement | null {
  const first = mainGroups[0]
  if (!first) {
    return null
  }
  const mainIds = new Set(mainGroups.map((group) => group.id))
  const strays = new Map(
    drawn.tabs
      .filter((tab) => inMain(tab) && !mainIds.has(tab.groupId))
      .map((tab) => [tab.id, nearestMainGroup(drawn, tab.groupId, mainIds, first.id)])
  )
  if (strays.size === 0) {
    return null
  }
  const into = (groupId: string): string[] =>
    [...strays].filter(([, to]) => to === groupId).map(([id]) => id)
  // The tab the user is on moves with them: shown in its new group, which becomes theirs. A tab
  // shown in another group moves unshown, so it never replaces what the user is looking at.
  const activeGroup = drawn.groups.find((group) => group.id === drawn.activeGroupId)
  const shownId =
    activeGroup?.activeTabId && strays.has(activeGroup.activeTabId)
      ? activeGroup.activeTabId
      : undefined
  const withMoved = (group: TabGroup, tabOrder: readonly string[]): TabGroup => ({
    ...group,
    tabOrder: [...tabOrder, ...into(group.id)]
  })
  return {
    tabGroupIdById: strays,
    groups: [
      ...drawn.groups.map((group) =>
        withMoved(
          group,
          group.tabOrder.filter((id) => !strays.has(id))
        )
      ),
      // A main group the window does not draw yet: drawn as main has it, plus the tabs moved in.
      ...mainGroups
        .filter((group) => !drawn.groups.some((candidate) => candidate.id === group.id))
        .filter((group) => into(group.id).length > 0)
        .map((group) => withMoved(group, group.tabOrder))
    ],
    shownTabId: shownId
  }
}
