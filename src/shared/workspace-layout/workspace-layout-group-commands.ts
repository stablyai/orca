// Commands on tab groups and the group split tree, built on the headless host's group moves so
// the runtime and today's headless host agree on the tree. There is no empty-group command: a
// group exists only while it holds a tab, so memory and disk never differ. An open into a new
// split makes its group and tab in one step (openInNewGroup).

import type { TabGroupLayoutNode } from '../tab-types'
import { buildHeadlessTabGroupMove, buildHeadlessTabGroupSplit } from './tab-group-moves'
import { moveGroupLeafBeside, moveGroupLeafBesideBranch } from './tab-group-layout-tree'
import {
  applied,
  findTab,
  refuse,
  workspaceOrEmpty,
  type Applied
} from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import type { WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'
import { groupShowsTabFile } from './workspace-layout-workspace-move'
import { withGroupSplitRatios } from './split-ratio-intents'

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
    return applied(
      withWorkspace(model, command.workspace, withMovedPin({ ...workspace, groups }, command))
    )
  }
  const tab = findTab(workspace, command.tabId)
  if (tab && groupShowsTabFile(workspace, command.toGroupId, tab)) {
    return refuse('tab_exists')
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
    withWorkspace(
      model,
      command.workspace,
      withMovedPin(
        { ...workspace, groups: moved.groups, groupLayout: moved.layout ?? undefined },
        command
      )
    )
  )
}

/** The pin a move sets lands with it, where `index` put the tab: no pin re-sort. */
function withMovedPin(workspace: WorkspaceLayout, command: CommandOf<'moveTab'>): WorkspaceLayout {
  const { isPinned } = command
  if (isPinned === undefined) {
    return workspace
  }
  return {
    ...workspace,
    tabs: workspace.tabs.map((tab) => (tab.id === command.tabId ? { ...tab, isPinned } : tab))
  }
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
  const groupLayout = !current
    ? null
    : command.ratios
      ? withGroupSplitRatios(current, command.ratios)
      : command.groupLayout && sameGroupsIgnoringRatios(current, command.groupLayout)
        ? command.groupLayout
        : null
  if (!groupLayout) {
    return refuse('group_set_changed')
  }
  return applied(withWorkspace(model, command.workspace, { ...workspace, groupLayout }))
}

type NewGroupOpen = CommandOf<
  | 'createTerminalTab'
  | 'openEditorTab'
  | 'openBrowserTab'
  | 'openAgentSessionTab'
  | 'openSimulatorTab'
>

/**
 * `open` into a new group `command.groupId` beside `split.besideGroupId`, as the window's split
 * does, or as the workspace's only group where main holds none. The group is added empty and
 * `open` fills it in the same apply, so it holds no preview to replace and no other tab for the
 * file. A group main already holds here takes the tab without a split; no split, just `open`.
 */
export function openInNewGroup(
  model: WorkspaceLayoutModel,
  command: NewGroupOpen,
  open: (model: WorkspaceLayoutModel) => Applied
): Applied {
  const split = command.split
  if (!split) {
    return open(model)
  }
  const workspaces = Object.values(model.workspaces)
  // A tab id already held goes to `open`, which decides what a repeat or a taken id does.
  if (
    command.tabId &&
    workspaces.some((entry) => entry.tabs.some((tab) => tab.id === command.tabId))
  ) {
    return open(model)
  }
  const groupId = command.groupId
  if (!groupId) {
    return refuse('invalid_params')
  }
  const workspace = workspaceOrEmpty(model, command.workspace)
  // A group main already holds here (with a tab the window no longer shows) takes the tab as is.
  if (workspace.groups.some((group) => group.id === groupId)) {
    return open(model)
  }
  if (workspaces.some((entry) => entry.groups.some((group) => group.id === groupId))) {
    return refuse('group_exists')
  }
  const lastGroupId = split.besideLastGroupId ?? split.besideGroupId
  const besideHeld = [split.besideGroupId, lastGroupId].every((id) =>
    workspace.groups.some((group) => group.id === id)
  )
  // Beside a group main lacks: refused, unless main has no group here at all (the window split off
  // its emptied root), where the new group is the only one.
  if (!besideHeld && workspace.groups.length > 0) {
    return refuse('group_not_found')
  }
  const groupLayout = besideHeld
    ? moveGroupLeafBesideBranch(
        workspace.groupLayout ?? { type: 'leaf', groupId: split.besideGroupId },
        groupId,
        split.besideGroupId,
        lastGroupId,
        split.direction
      )
    : undefined
  // Both groups held, but no branch of main's tree holds them both.
  if (besideHeld && !groupLayout) {
    return refuse('invalid_params')
  }
  const opened = open(
    withWorkspace(model, command.workspace, {
      ...workspace,
      groups: [...workspace.groups, { id: groupId, tabOrder: [] }],
      ...(groupLayout ? { groupLayout } : {})
    })
  )
  if (!opened.ok) {
    return opened
  }
  const filled = opened.model.workspaces[command.workspace]?.groups.some(
    (group) => group.id === groupId && group.tabOrder.length > 0
  )
  // An open that placed nothing (an initial surface the workspace already has) adds no group.
  return filled ? opened : applied(model, opened.result)
}
