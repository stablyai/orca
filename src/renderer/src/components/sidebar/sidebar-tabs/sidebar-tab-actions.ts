import { useAppStore } from '@/store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateBrowserWorkspaceTab } from '@/lib/browser-workspace-tab-activation'
import { activateSimulatorTabPaletteResult } from '@/lib/simulator-tab-palette-activation'
import { activateStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import { activateWorkspaceTabPaletteResult } from '@/lib/workspace-tab-palette-activation'
import type { WorkspaceTabContentType } from '@/lib/workspace-tab-palette-search'
import { closeWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-close'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { createNewTerminalTab } from '@/components/terminal/terminal-tab-create'
import type { Tab } from '../../../../../shared/tab-types'
import { isSidebarEditorTab } from './sidebar-tab-model'

// Routes through the same per-kind activation paths Cmd+J uses, so surface type,
// group focus and host routing match a top-strip click.
export function activateSidebarTab(tab: Tab, leafId?: string): void {
  const { worktreeId } = tab
  if (tab.contentType === 'browser') {
    activateBrowserWorkspaceTab({ worktreeId, workspaceId: tab.entityId })
    return
  }
  if (tab.contentType === 'simulator') {
    activateSimulatorTabPaletteResult({ tabId: tab.id, worktreeId })
    return
  }
  if (tab.contentType === 'agent-session') {
    activateStructuredAgentSessionTab({ worktreeId, tabId: tab.id })
    return
  }
  const result = activateWorkspaceTabPaletteResult({
    contentType: tab.contentType as WorkspaceTabContentType,
    entityId: tab.entityId,
    groupId: tab.groupId,
    tabId: tab.id,
    worktreeId
  })
  if (result.status === 'activated' && tab.contentType === 'terminal' && leafId) {
    activateTabAndFocusPane(tab.entityId, leafId)
  }
}

export function closeSidebarTab(tab: Tab): void {
  if (tab.contentType === 'terminal') {
    // Why: keeps the running-process and pinned-tab guards of the top strip.
    closeTerminalTab(tab.entityId)
    return
  }
  if (tab.contentType === 'browser') {
    closeWorkspaceBrowserTab(tab.worktreeId, tab.entityId)
    return
  }
  const state = useAppStore.getState()
  if (isSidebarEditorTab(tab)) {
    state.closeFile(tab.entityId)
    return
  }
  state.closeUnifiedTab(tab.id)
}

export function openSidebarTerminalTab(worktreeId: string): void {
  createNewTerminalTab(worktreeId)
}
