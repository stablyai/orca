import { findTab, refuse, updateTab, type Applied } from './workspace-layout-command-steps'
import type { CommandOf } from './workspace-layout-command-types'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

export function renameTab(model: WorkspaceLayoutModel, command: CommandOf<'renameTab'>): Applied {
  const tab = findTab(model.workspaces[command.workspace]!, command.tabId)
  if (!tab) {
    return refuse('tab_not_found')
  }
  if (command.kind === 'aiVault') {
    return updateTab(model, command.workspace, { ...tab, aiVaultTitle: command.title })
  }
  if (command.kind === 'custom') {
    const expected = command.expected
    if (
      expected &&
      (tab.kind !== 'agent-session' ||
        tab.entityId !== expected.entityId ||
        model.hostId !== expected.executionHostId ||
        tab.customTitle !== expected.customTitle)
    ) {
      return refuse('tab_not_found')
    }
    return updateTab(model, command.workspace, { ...tab, customTitle: command.title })
  }
  // As the window's own generated titles: an agent's later prompt does not rename the tab.
  if (tab.generatedTitle?.trim() && !command.replaceExisting) {
    return refuse('generated_title_kept')
  }
  return updateTab(model, command.workspace, { ...tab, generatedTitle: command.title })
}
