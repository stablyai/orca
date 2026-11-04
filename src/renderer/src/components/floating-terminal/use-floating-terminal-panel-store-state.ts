import { floatingWorkspaceEnvironmentId } from '../../../../shared/floating-workspace-id'
import { useMemo } from 'react'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { useAppStore } from '@/store'
import { useFloatingWorkspaceId } from '@/lib/floating-workspace-host'
import { createFloatingTerminalPanelInputsSelector } from './floating-terminal-panel-inputs'

export function useFloatingTerminalPanelStoreState() {
  const worktreeId = useFloatingWorkspaceId()
  const selectInputs = useMemo(
    () => createFloatingTerminalPanelInputsSelector({}, worktreeId),
    [worktreeId]
  )
  const { tabs, browserTabs, groups, unifiedTabs, floatingFiles, expandedPaneByTabId } =
    useAppStore(selectInputs)
  const createTab = useAppStore((state) => state.createTab)
  const createBrowserTab = useAppStore((state) => state.createBrowserTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const closeFile = useAppStore((state) => state.closeFile)
  const closeUnifiedTab = useAppStore((state) => state.closeUnifiedTab)
  const activateTab = useAppStore((state) => state.activateTab)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const setTabColor = useAppStore((state) => state.setTabColor)
  const setTabPaneExpanded = useAppStore((state) => state.setTabPaneExpanded)
  const makePreviewFilePermanent = useAppStore((state) => state.makePreviewFilePermanent)
  const pinFile = useAppStore((state) => state.pinFile)
  const openFile = useAppStore((state) => state.openFile)
  const browserDefaultUrl = useAppStore((state) => state.browserDefaultUrl)
  const floatingTerminalCwd = useAppStore((state) => state.settings?.floatingTerminalCwd ?? '')
  // The host-resolved floating directory; the geometry hook keeps it fresh.
  const cwd = useAppStore((state) => state.floatingWorkspacePath)
  const setFloatingWorkspacePath = useAppStore((state) => state.setFloatingWorkspacePath)
  const generatedTabTitlesEnabled = useAppStore(
    (state) => state.settings?.tabAutoGenerateTitle === true
  )
  const managedBrowserCreationEnabled = useAppStore(
    (state) =>
      getClientCreationActionPolicy(state, worktreeId)['managed-browser'].state === 'enabled'
  )

  return {
    tabs,
    browserTabs,
    groups,
    unifiedTabs,
    floatingFiles,
    expandedPaneByTabId,
    createTab,
    createBrowserTab,
    closeTab,
    closeFile,
    closeUnifiedTab,
    activateTab,
    setActiveTab,
    setTabCustomTitle,
    setTabColor,
    setTabPaneExpanded,
    makePreviewFilePermanent,
    pinFile,
    openFile,
    browserDefaultUrl,
    floatingTerminalCwd,
    cwd: floatingWorkspaceEnvironmentId(worktreeId) ? '~' : cwd,
    setFloatingWorkspacePath,
    generatedTabTitlesEnabled,
    managedBrowserCreationEnabled
  }
}

export type FloatingTerminalPanelStoreState = ReturnType<typeof useFloatingTerminalPanelStoreState>
