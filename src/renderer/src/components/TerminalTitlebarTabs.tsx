import { createPortal } from 'react-dom'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '../store'
import TabBar from './tab-bar/TabBar'
import type { TerminalController } from './use-terminal-controller'

const EMPTY_TERMINAL_TABS: TerminalTab[] = []

// Why: keeps title-only tab updates a leaf subscription so the Terminal root,
// which reads the topology projection, does not re-render on every rename.
function LiveTerminalTabBar(
  props: Omit<React.ComponentProps<typeof TabBar>, 'tabs'>
): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabsByWorktree[props.worktreeId] ?? EMPTY_TERMINAL_TABS)
  return <TabBar {...props} tabs={tabs} />
}

export function TerminalTitlebarTabs({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const {
    activeBrowserTabId,
    activeFileId,
    activeTabId,
    activeTabType,
    effectiveActiveLayout,
    expandedPaneByTabId,
    handleActivateBrowserTab,
    handleActivateTab,
    handleCloseAllFiles,
    handleCloseBrowserTab,
    handleCloseFile,
    handleCloseOthers,
    handleCloseTab,
    handleCloseTabsToLeft,
    handleCloseTabsToRight,
    handleDuplicateBrowserTab,
    handleNewBrowserTab,
    handleNewFile,
    handleNewSimulatorTab,
    handleNewTab,
    handleOpenEntry,
    handleTogglePaneExpand,
    makePreviewFilePermanent,
    mobileEmulatorEnabled,
    pinFile,
    renderedActiveWorktreeId,
    setActiveFile,
    setActiveTab,
    setActiveTabType,
    setTabColor,
    setTabCustomTitle,
    tabBarOrder,
    titlebarTabsTarget,
    worktreeBrowserTabs,
    worktreeClientHostedBrowserRows,
    worktreeFiles
  } = controller
  if (!renderedActiveWorktreeId || effectiveActiveLayout || !titlebarTabsTarget) {
    return null
  }
  return createPortal(
    <LiveTerminalTabBar
      activeTabId={activeTabId}
      worktreeId={renderedActiveWorktreeId}
      onActivate={handleActivateTab}
      onClose={handleCloseTab}
      onCloseOthers={handleCloseOthers}
      onCloseToRight={handleCloseTabsToRight}
      onCloseToLeft={handleCloseTabsToLeft}
      onNewTerminalTab={() => handleNewTab()}
      onNewTerminalWithShell={handleNewTab}
      onNewBrowserTab={handleNewBrowserTab}
      onNewSimulatorTab={mobileEmulatorEnabled ? handleNewSimulatorTab : undefined}
      onOpenEntry={handleOpenEntry}
      onNewFileTab={handleNewFile}
      onSetCustomTitle={setTabCustomTitle}
      onSetTabColor={setTabColor}
      expandedPaneByTabId={expandedPaneByTabId}
      onTogglePaneExpand={handleTogglePaneExpand}
      editorFiles={worktreeFiles}
      browserTabs={worktreeBrowserTabs}
      clientHostedBrowserRows={worktreeClientHostedBrowserRows}
      activeFileId={activeFileId}
      activeBrowserTabId={activeBrowserTabId}
      activeSimulatorTabId={
        activeTabType === 'simulator' && renderedActiveWorktreeId
          ? (useAppStore.getState().getActiveTab(renderedActiveWorktreeId)?.id ?? null)
          : null
      }
      activeTabType={activeTabType}
      onActivateFile={(fileId) => {
        const unifiedTabs =
          useAppStore.getState().unifiedTabsByWorktree[renderedActiveWorktreeId ?? ''] ?? []
        const unifiedTab = unifiedTabs.find((tab) => tab.id === fileId)
        if (unifiedTab?.contentType === 'simulator') {
          setActiveTab(fileId)
          setActiveTabType('simulator')
          return
        }
        setActiveFile(fileId)
        setActiveTabType('editor')
      }}
      onCloseFile={handleCloseFile}
      onActivateBrowserTab={handleActivateBrowserTab}
      onCloseBrowserTab={handleCloseBrowserTab}
      onDuplicateBrowserTab={handleDuplicateBrowserTab}
      onCloseAllFiles={handleCloseAllFiles}
      onMakePreviewFilePermanent={makePreviewFilePermanent}
      onPinFile={pinFile}
      tabBarOrder={tabBarOrder}
    />,
    titlebarTabsTarget
  )
}
