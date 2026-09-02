import { createPortal } from 'react-dom'
import TerminalPane from './terminal-pane/TerminalPane'
import { findActivityTerminalPortal } from './activity/activity-terminal-portal'
import { shouldMountBackgroundWorktreeTab } from './terminal/background-terminal-worktree-mount'
import type { TerminalController } from './use-terminal-controller'

export function TerminalLegacyTerminalPanes({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element {
  const {
    activeTabId,
    activeTabType,
    activeView,
    activityTerminalPortals,
    backgroundMountTabIdsByWorktreeRef,
    effectiveParkedTerminalWorktreeIds,
    evictionExemptTerminalTabIds,
    handleCloseTab,
    handlePtyExit,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    tabsByWorktree,
    worktreeBrowserTabs,
    worktreeFiles,
    workspaceSurfaces
  } = controller
  return (
    <div
      className={`relative flex-1 min-h-0 overflow-hidden ${
        (activeTabType === 'editor' && worktreeFiles.length > 0) ||
        (activeTabType === 'browser' && worktreeBrowserTabs.length > 0) ||
        activeTabType === 'simulator'
          ? 'hidden'
          : ''
      }`}
    >
      {workspaceSurfaces
        .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
        .map((workspace) => {
          const isVisible = activeView === 'terminal' && workspace.id === renderedActiveWorktreeId
          const shouldMeasureHiddenWorktree =
            !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspace.id)
          const shouldColdParkTerminalPanes =
            !isVisible &&
            !shouldMeasureHiddenWorktree &&
            effectiveParkedTerminalWorktreeIds.has(workspace.id)
          return (
            <div
              key={workspace.id}
              className={
                isVisible
                  ? 'absolute inset-0'
                  : shouldMeasureHiddenWorktree
                    ? 'absolute inset-0 opacity-0 pointer-events-none'
                    : 'absolute inset-0 hidden'
              }
              aria-hidden={!isVisible}
            >
              {(tabsByWorktree[workspace.id] ?? [])
                .filter((tab) =>
                  shouldMountBackgroundWorktreeTab(
                    backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null,
                    tab.id
                  )
                )
                .map((tab) => {
                  const activityTerminalPortal = findActivityTerminalPortal(
                    activityTerminalPortals,
                    { worktreeId: workspace.id, tabId: tab.id }
                  )
                  const isActivityPortalTab = activityTerminalPortal !== null
                  const isActiveTerminalTab =
                    isVisible && tab.id === activeTabId && activeTabType === 'terminal'
                  if (
                    shouldColdParkTerminalPanes &&
                    !isActivityPortalTab &&
                    !evictionExemptTerminalTabIds.has(tab.id)
                  ) {
                    return null
                  }
                  const terminalPane = (
                    <TerminalPane
                      key={`${tab.id}-${tab.generation ?? 0}`}
                      tabId={tab.id}
                      worktreeId={workspace.id}
                      cwd={tab.startupCwd ?? workspace.path}
                      isActive={isActiveTerminalTab || activityTerminalPortal?.active === true}
                      isVisible={isActiveTerminalTab || isActivityPortalTab}
                      isWorktreeActive={isVisible || isActivityPortalTab}
                      isolatedPaneKey={activityTerminalPortal?.paneKey ?? null}
                      onPtyExit={(ptyId, exitCode) => handlePtyExit(tab.id, ptyId, exitCode)}
                      onCloseTab={() => handleCloseTab(tab.id)}
                    />
                  )
                  if (activityTerminalPortal) {
                    return createPortal(
                      terminalPane,
                      activityTerminalPortal.target,
                      `activity-terminal-${tab.id}`
                    )
                  }
                  return terminalPane
                })}
            </div>
          )
        })}
    </div>
  )
}
