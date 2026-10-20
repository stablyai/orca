// applyLayoutCommand: every layout change a client can ask for, applied to the model in one step.
// Pure and synchronous, so the runtime applies commands in arrival order on one thread.

import {
  closeBrowserPage,
  openBrowserPage,
  replaceBrowserPage,
  setBrowserTabProfile
} from './workspace-layout-browser-commands'
import { applied, refuse, type Applied } from './workspace-layout-command-steps'
import type {
  CommandOf,
  LayoutCommand,
  LayoutContext,
  RenameTabsCommand
} from './workspace-layout-command-types'
import {
  openAgentSessionTab,
  openBrowserTab,
  openEditorTab
} from './workspace-layout-content-commands'
import {
  moveTab,
  openInNewGroup,
  setGroupRatios,
  splitGroup
} from './workspace-layout-group-commands'
import { renameEditorFiles } from './workspace-layout-editor-rekey'
import { openSimulatorTab } from './workspace-layout-simulator-tab'
import { updateLegacyPersistence } from './workspace-layout-legacy-persistence'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import {
  closePane,
  equalizePanes,
  movePane,
  movePaneToNewTab,
  renamePane,
  setPaneGrid,
  releasePaneTerminal,
  setPaneRatios,
  splitPane
} from './workspace-layout-pane-commands'
import { restartPane, sleep, startPane, wake } from './workspace-layout-process-commands'
import {
  closeTabs,
  createTerminalTab,
  promotePreviewTab,
  renameTab,
  setChatPane,
  setTabProps
} from './workspace-layout-tab-commands'
import { moveTabToWorkspace } from './workspace-layout-workspace-move'
import { applyDefaultTabs } from './workspace-layout-default-tabs'

const CREATES_WORKSPACE = new Set<LayoutCommand['type']>([
  'createTerminalTab',
  'openEditorTab',
  'openBrowserTab',
  'openAgentSessionTab',
  'openSimulatorTab'
])

/** A `renameTabs` as the `renameTab` each of its titles is. */
export function renameTabCommandsOf(command: RenameTabsCommand): CommandOf<'renameTab'>[] {
  return command.renames.map(({ workspace, tabId, title }) => ({
    type: 'renameTab',
    workspace,
    tabId,
    kind: command.kind,
    title
  }))
}

export function applyLayoutCommand(
  model: WorkspaceLayoutModel,
  command: LayoutCommand,
  context: LayoutContext
): Applied {
  const result = applyCommand(model, command, context)
  return result.ok ? { ...result, model: updateLegacyPersistence(model, result.model) } : result
}

function applyCommand(
  model: WorkspaceLayoutModel,
  command: LayoutCommand,
  context: LayoutContext
): Applied {
  if (command.type === 'setDefaultTabsApplied') {
    return setDefaultTabsApplied(model, command.workspace)
  }
  if (command.type === 'applyDefaultTabs') {
    return applyDefaultTabs(model, command, context, setDefaultTabsApplied)
  }
  if (!model.workspaces[command.workspace] && !CREATES_WORKSPACE.has(command.type)) {
    // Closing what is already gone is not an error (#10747).
    if (command.type === 'closeTabs') {
      return applied(model, { alreadyClosed: true, closed: command.tabIds, refused: [] })
    }
    return command.type === 'closePane'
      ? applied(model, { alreadyClosed: true })
      : refuse('workspace_not_found')
  }
  switch (command.type) {
    case 'createTerminalTab':
      return openInNewGroup(model, command, (next) => createTerminalTab(next, command, context))
    case 'splitPane':
      return splitPane(model, command, context)
    case 'closePane':
      return closePane(model, command)
    case 'closeTabs':
      return closeTabs(model, command, context)
    case 'moveTab':
      return moveTab(model, command)
    case 'splitGroup':
      return splitGroup(model, command, context)
    case 'setGroupRatios':
      return setGroupRatios(model, command)
    case 'setPaneRatios':
      return setPaneRatios(model, command)
    case 'movePane':
      return movePane(model, command)
    case 'equalizePanes':
      return equalizePanes(model, command)
    case 'movePaneToNewTab':
      return movePaneToNewTab(model, command, context)
    case 'renameTab':
      return renameTab(model, command)
    case 'renamePane':
      return renamePane(model, command)
    case 'setPaneGrid':
      return setPaneGrid(model, command)
    case 'releasePaneTerminal':
      return releasePaneTerminal(model, command)
    case 'setTabProps':
      return setTabProps(model, command)
    case 'setChatPane':
      return setChatPane(model, command)
    case 'openEditorTab':
      return openInNewGroup(model, command, (next) => openEditorTab(next, command, context))
    case 'openSimulatorTab':
      return openInNewGroup(model, command, (next) => openSimulatorTab(next, command, context))
    case 'promotePreviewTab':
      return promotePreviewTab(model, command)
    case 'moveTabToWorkspace':
      return moveTabToWorkspace(model, command, context)
    case 'renameEditorFiles':
      return renameEditorFiles(model, command)
    case 'openBrowserTab':
      return openInNewGroup(model, command, (next) => openBrowserTab(next, command, context))
    case 'openBrowserPage':
      return openBrowserPage(model, command)
    case 'closeBrowserPage':
      return closeBrowserPage(model, command)
    case 'replaceBrowserPage':
      return replaceBrowserPage(model, command)
    case 'setBrowserTabProfile':
      return setBrowserTabProfile(model, command)
    case 'openAgentSessionTab':
      return openInNewGroup(model, command, (next) => openAgentSessionTab(next, command, context))
    case 'startPane':
      return startPane(model, command, context)
    case 'restartPane':
      return restartPane(model, command)
    case 'sleep':
      return sleep(model, command)
    case 'wake':
      return wake(model, command)
  }
}

// A record, not a layout: a workspace with no tabs yet (zero templates) is marked, not created.
function setDefaultTabsApplied(model: WorkspaceLayoutModel, workspace: string): Applied {
  const marks = model.records.defaultTabsAppliedByWorkspace
  if (marks?.[workspace]) {
    return applied(model)
  }
  return applied({
    ...model,
    records: { ...model.records, defaultTabsAppliedByWorkspace: { ...marks, [workspace]: true } }
  })
}
