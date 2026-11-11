import type { TabGroupLayoutNode } from '../tab-types'
import { changedSplitRatios, splitRatioIntentAt, withGroupSplitRatios } from './split-ratio-intents'
import type { CommandOf, LayoutCommand, RenameTabsCommand } from './workspace-layout-command-types'
import {
  visibleGroupTree,
  visibleLayoutGroups,
  type LayoutClientVisibility
} from './workspace-layout-client-visibility'
import type { WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'

type GroupPlacement = {
  groupId?: string
  split?: { besideGroupId: string; besideLastGroupId?: string }
}

function placement<C extends GroupPlacement>(
  workspace: WorkspaceLayout | undefined,
  command: C,
  visible: LayoutClientVisibility
): C {
  if (!workspace || workspace.tabs.every(visible)) {
    return command
  }
  const empty = !workspace.tabs.some(visible)
  const groups = visibleLayoutGroups(workspace, visible)
  const first = groups[0] ?? workspace.groups[0]
  if (!first) {
    return command
  }
  if (command.split) {
    // Only an emptied projected root may stand in for a missing split anchor.
    if (!empty) {
      return command
    }
    const anchor = (id: string) =>
      workspace.groups.some((group) => group.id === id) ? id : first.id
    return {
      ...command,
      split: {
        ...command.split,
        besideGroupId: anchor(command.split.besideGroupId),
        ...(command.split.besideLastGroupId
          ? { besideLastGroupId: anchor(command.split.besideLastGroupId) }
          : {})
      }
    }
  }
  if (command.groupId && workspace.groups.some((group) => group.id === command.groupId)) {
    return command
  }
  // Unknown groups still refuse when the client has a nonempty layout.
  return command.groupId && !empty ? command : { ...command, groupId: first.id }
}

function sameGroupTree(left: TabGroupLayoutNode, right: TabGroupLayoutNode): boolean {
  return left.type === 'leaf' || right.type === 'leaf'
    ? left.type === 'leaf' && right.type === 'leaf' && left.groupId === right.groupId
    : left.direction === right.direction &&
        sameGroupTree(left.first, right.first) &&
        sameGroupTree(left.second, right.second)
}

function ratios(
  workspace: WorkspaceLayout | undefined,
  command: CommandOf<'setGroupRatios'>,
  visible: LayoutClientVisibility
): CommandOf<'setGroupRatios'> {
  if (!workspace || workspace.tabs.every(visible)) {
    return command
  }
  const paths = new Map<string, string>()
  const current =
    workspace?.groupLayout ??
    (workspace?.groups[0] && { type: 'leaf' as const, groupId: workspace.groups[0].id })
  const tree = visibleGroupTree(
    current,
    new Set(workspace ? visibleLayoutGroups(workspace, visible).map((group) => group.id) : []),
    paths
  )
  const changes =
    command.ratios ??
    (tree && command.groupLayout && sameGroupTree(tree, command.groupLayout)
      ? changedSplitRatios(tree, command.groupLayout)
      : undefined)
  if (!tree || !changes || !withGroupSplitRatios(tree, changes)) {
    return { ...command, groupLayout: undefined, ratios: undefined }
  }
  const translated = changes.flatMap(({ path, ratio }) => {
    const canonical = paths.get(path)
    const intent = canonical === undefined ? null : splitRatioIntentAt(current!, canonical, ratio)
    return intent ? [intent] : []
  })
  return translated.length === changes.length
    ? { ...command, groupLayout: undefined, ratios: translated }
    : { ...command, groupLayout: undefined, ratios: undefined }
}

export function clientLayoutCommand(
  model: WorkspaceLayoutModel,
  command: LayoutCommand,
  visible?: LayoutClientVisibility
): LayoutCommand
export function clientLayoutCommand(
  model: WorkspaceLayoutModel,
  command: LayoutCommand | RenameTabsCommand,
  visible?: LayoutClientVisibility
): LayoutCommand | RenameTabsCommand
/** Classify every command; coordinates are resolved only against the model being mutated. */
export function clientLayoutCommand(
  model: WorkspaceLayoutModel,
  command: LayoutCommand | RenameTabsCommand,
  visible?: LayoutClientVisibility
): LayoutCommand | RenameTabsCommand {
  if (!visible) {
    return command
  }
  switch (command.type) {
    case 'createTerminalTab':
    case 'openEditorTab':
    case 'openSimulatorTab':
    case 'openBrowserTab':
    case 'openAgentSessionTab':
      return placement(model.workspaces[command.workspace], command, visible)
    case 'movePaneToNewTab': {
      const workspace = model.workspaces[command.workspace]
      const groupId =
        command.groupId ??
        workspace?.groups.find((group) => group.tabOrder.includes(command.tabId))?.id
      return placement(workspace, { ...command, groupId }, visible)
    }
    case 'moveTabToWorkspace':
      return placement(model.workspaces[command.toWorkspace], command, visible)
    case 'moveTab': {
      const resolved = placement(
        model.workspaces[command.workspace],
        { groupId: command.toGroupId },
        visible
      )
      return { ...command, toGroupId: resolved.groupId! }
    }
    case 'setGroupRatios':
      return ratios(model.workspaces[command.workspace], command, visible)
    case 'splitGroup':
      // The primitive evaluates visible cardinality without moving hidden siblings.
      return command
    case 'renameTabs':
    case 'splitPane':
    case 'closePane':
    case 'closeTabs':
    case 'setPaneRatios':
    case 'movePane':
    case 'equalizePanes':
    case 'renameTab':
    case 'renamePane':
    case 'setPaneGrid':
    case 'releasePaneTerminal':
    case 'setTabProps':
    case 'setChatPane':
    case 'promotePreviewTab':
    case 'renameEditorFiles':
    case 'openBrowserPage':
    case 'closeBrowserPage':
    case 'replaceBrowserPage':
    case 'setBrowserTabProfile':
    case 'startPane':
    case 'restartPane':
    case 'sleep':
    case 'wake':
    case 'setDefaultTabsApplied':
    case 'applyDefaultTabs':
      return command
  }
}
