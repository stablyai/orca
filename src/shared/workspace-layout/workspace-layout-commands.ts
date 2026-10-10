// applyLayoutCommand: every layout change a client can ask for, applied to the model in one step.
// Pure and synchronous, so the runtime applies commands in arrival order on one thread.

import { applied, refuse, type Applied } from './workspace-layout-command-steps'
import type { LayoutCommand, LayoutContext } from './workspace-layout-command-types'
import {
  openAgentSessionTab,
  openBrowserTab,
  openEditorTab
} from './workspace-layout-content-commands'
import { moveTab, setGroupRatios, splitGroup } from './workspace-layout-group-commands'
import { updateLegacyPersistence } from './workspace-layout-legacy-persistence'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import {
  closePane,
  equalizePanes,
  movePane,
  movePaneToNewTab,
  renamePane,
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

const CREATES_WORKSPACE = new Set<LayoutCommand['type']>([
  'createTerminalTab',
  'openEditorTab',
  'openBrowserTab',
  'openAgentSessionTab'
])

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
      return createTerminalTab(model, command, context)
    case 'splitPane':
      return splitPane(model, command, context)
    case 'closePane':
      return closePane(model, command)
    case 'closeTabs':
      return closeTabs(model, command)
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
    case 'setTabProps':
      return setTabProps(model, command)
    case 'setChatPane':
      return setChatPane(model, command)
    case 'openEditorTab':
      return openEditorTab(model, command, context)
    case 'promotePreviewTab':
      return promotePreviewTab(model, command)
    case 'openBrowserTab':
      return openBrowserTab(model, command, context)
    case 'openAgentSessionTab':
      return openAgentSessionTab(model, command, context)
    case 'startPane':
      return startPane(model, command)
    case 'restartPane':
      return restartPane(model, command)
    case 'sleep':
      return sleep(model, command)
    case 'wake':
      return wake(model, command)
  }
}
