import type { TabGroup, TabGroupLayoutNode } from './tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'

/** Group-shape helpers for the terminal-tab move path (kept out of the move module's line budget). */

export function pruneGroupLayout(
  node: TabGroupLayoutNode | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | undefined {
  if (!node) {
    return undefined
  }
  if (node.type === 'leaf') {
    return validGroupIds.has(node.groupId) ? node : undefined
  }
  const first = pruneGroupLayout(node.first, validGroupIds)
  const second = pruneGroupLayout(node.second, validGroupIds)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

export function pickNextActiveTab(
  group: TabGroup,
  closingIds: ReadonlySet<string>
): string | null {
  const remaining = group.tabOrder.filter((id) => !closingIds.has(id))
  for (let index = (group.recentTabIds?.length ?? 0) - 1; index >= 0; index -= 1) {
    const id = group.recentTabIds![index]
    if (remaining.includes(id)) {
      return id
    }
  }
  const closingIndex = group.tabOrder.findIndex((id) => closingIds.has(id))
  return (
    remaining.find((id) => group.tabOrder.indexOf(id) > closingIndex) ?? remaining.at(-1) ?? null
  )
}

export function ensureDestGroup(
  session: WorkspaceSessionState,
  destWorktreeId: string
): { groups: TabGroup[]; group: TabGroup; layout: TabGroupLayoutNode } {
  const groups = [...(session.tabGroups?.[destWorktreeId] ?? [])]
  // Why: the destination pane must be the one the user is looking at (the focused
  // split pane), not whatever pane happens to sit first in the layout.
  const focused =
    groups.find((group) => group.id === session.activeGroupIdByWorktree?.[destWorktreeId]) ??
    groups[0]
  if (focused) {
    return {
      groups,
      group: focused,
      layout: session.tabGroupLayouts?.[destWorktreeId] ?? { type: 'leaf', groupId: focused.id }
    }
  }
  const group: TabGroup = {
    id: `group-${destWorktreeId}`,
    worktreeId: destWorktreeId,
    activeTabId: null,
    tabOrder: [],
    recentTabIds: []
  }
  return {
    groups: [group],
    group,
    layout: { type: 'leaf', groupId: group.id }
  }
}
