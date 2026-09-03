import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { selectFloatingTerminalPanelInputs } from './floating-terminal-panel-inputs'

export function useFloatingTerminalPanelStoreState() {
  const { tabs, browserTabs, groups, unifiedTabs, floatingFiles, expandedPaneByTabId } =
    useAppStore(selectFloatingTerminalPanelInputs)
  const createTab = useAppStore((state) => state.createTab)
  const createBrowserTab = useAppStore((state) => state.createBrowserTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const closeBrowserTab = useAppStore((state) => state.closeBrowserTab)
  const closeFile = useAppStore((state) => state.closeFile)
  const closeUnifiedTab = useAppStore((state) => state.closeUnifiedTab)
  const markFileDirty = useAppStore((state) => state.markFileDirty)
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
  const generatedTabTitlesEnabled = useAppStore(
    (state) => state.settings?.tabAutoGenerateTitle === true
  )
  const managedBrowserCreationEnabled = useAppStore(
    (state) =>
      getClientCreationActionPolicy(state, FLOATING_TERMINAL_WORKTREE_ID)['managed-browser']
        .state === 'enabled'
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
    closeBrowserTab,
    closeFile,
    closeUnifiedTab,
    markFileDirty,
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
    generatedTabTitlesEnabled,
    managedBrowserCreationEnabled
  }
}

export type FloatingTerminalPanelStoreState = ReturnType<typeof useFloatingTerminalPanelStoreState>
