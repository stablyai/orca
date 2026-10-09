// Commands on tab groups and the group split tree, built on the headless host's group moves so
// the runtime and today's headless host agree on the tree. There is no empty-group command: a
// group exists only while it holds a tab, so memory and disk never differ.

import type { TabGroupLayoutNode } from '../tab-types'
import { buildHeadlessTabGroupMove, buildHeadlessTabGroupSplit } from './tab-group-moves'
import { moveGroupLeafBeside } from './tab-group-layout-tree'
import { applied, findTab, refuse, type Applied } from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import type { WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'

function sourceGroupOf(workspace: WorkspaceLayout, tabId: string) {
  return findTab(workspace, tabId)
    ? workspace.groups.find((group) => group.tabOrder.includes(tabId))
    : undefined
}

export function moveTab(model: WorkspaceLayoutModel, command: CommandOf<'moveTab'>): Applied {
  const workspace = model.workspaces[command.workspace]!
  const source = sourceGroupOf(workspace, command.tabId)
  if (!source) {
    return refuse('tab_not_found')
  }
  if (!workspace.groups.some((group) => group.id === command.toGroupId)) {
    return refuse('group_not_found')
  }
  if (source.id === command.toGroupId) {
    const tabOrder = source.tabOrder.filter((id) => id !== command.tabId)
    tabOrder.splice(Math.max(0, Math.min(command.index, tabOrder.length)), 0, command.tabId)
    const groups = workspace.groups.map((group) =>
      group.id === source.id ? { ...group, tabOrder } : group
    )
    return applied(withWorkspace(model, command.workspace, { ...workspace, groups }))
  }
  const moved = buildHeadlessTabGroupMove({
    groups: workspace.groups,
    layout: workspace.groupLayout,
    tabId: command.tabId,
    targetGroupId: command.toGroupId,
    index: command.index
  })
  if (!moved) {
    return refuse('invalid_params')
  }
  return applied(
    withWorkspace(model, command.workspace, {
      ...workspace,
      groups: moved.groups,
      groupLayout: moved.layout ?? undefined
    })
  )
}

export function splitGroup(
  model: WorkspaceLayoutModel,
  command: CommandOf<'splitGroup'>,
  context: LayoutContext
): Applied {
  const workspace = model.workspaces[command.workspace]!
  const source = sourceGroupOf(workspace, command.tabId)
  if (!source) {
    return refuse('tab_not_found')
  }
  if (!workspace.groups.some((group) => group.id === command.besideGroupId)) {
    return refuse('group_not_found')
  }
  if (source.tabOrder.length === 1 && source.id !== command.besideGroupId) {
    // The group's only tab moves with its group, so the group keeps its id (ids never change).
    const groupLayout = moveGroupLeafBeside(
      workspace.groupLayout ?? { type: 'leaf', groupId: source.id },
      source.id,
      command.besideGroupId,
      command.direction
    )
    return applied(withWorkspace(model, command.workspace, { ...workspace, groupLayout }), {
      groupId: source.id
    })
  }
  const split = buildHeadlessTabGroupSplit({
    groups: workspace.groups,
    layout: workspace.groupLayout,
    tabId: command.tabId,
    targetGroupId: command.besideGroupId,
    splitDirection: command.direction,
    newGroupId: context.mintId()
  })
  if (!split) {
    // Splitting a group's only tab off itself would leave nothing behind.
    return refuse('invalid_params')
  }
  return applied(
    withWorkspace(model, command.workspace, {
      ...workspace,
      groups: split.groups,
      groupLayout: split.layout
    }),
    {
      groupId: split.newGroupId
    }
  )
}

function sameGroupsIgnoringRatios(left: TabGroupLayoutNode, right: TabGroupLayoutNode): boolean {
  if (left.type === 'leaf' || right.type === 'leaf') {
    return left.type === 'leaf' && right.type === 'leaf' && left.groupId === right.groupId
  }
  return (
    left.direction === right.direction &&
    sameGroupsIgnoringRatios(left.first, right.first) &&
    sameGroupsIgnoringRatios(left.second, right.second)
  )
}

export function setGroupRatios(
  model: WorkspaceLayoutModel,
  command: CommandOf<'setGroupRatios'>
): Applied {
  const workspace = model.workspaces[command.workspace]!
  const first = workspace.groups[0]
  const current = workspace.groupLayout ?? (first && { type: 'leaf' as const, groupId: first.id })
  if (!current || !sameGroupsIgnoringRatios(current, command.groupLayout)) {
    return refuse('group_set_changed')
  }
  return applied(
    withWorkspace(model, command.workspace, { ...workspace, groupLayout: command.groupLayout })
  )
}
