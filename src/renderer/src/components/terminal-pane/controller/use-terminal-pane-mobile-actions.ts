import { useMobileTerminalFitActions } from '../viewport/use-mobile-terminal-fit-actions'
import { useTerminalPrimarySelectionActions } from '../input/selection/use-terminal-primary-selection-actions'
import { useTerminalPaneHeaderActions } from '../titles/use-terminal-pane-header-actions'
import type { TerminalPaneContextController } from './use-terminal-pane-context-actions'

export function useTerminalPaneMobileActions(controller: TerminalPaneContextController) {
  const {
    cwd,
    managerRef,
    paneCwdRef,
    paneTransportsRef,
    refreshMobileOverlays,
    setTerminalError,
    settingsRef,
    tabId,
    worktreeId
  } = controller
  const {
    getMobileOwnedTerminalPtyIds,
    scheduleRestoredTerminalRefit,
    restorePaneTerminalFit,
    restoreAllTerminalFits
  } = useMobileTerminalFitActions({ paneTransportsRef, refreshMobileOverlays, settingsRef })
  const {
    terminalShouldHandleMiddleClick,
    handlePrimarySelectionMiddleMouseDown,
    handlePrimarySelectionAuxClick
  } = useTerminalPrimarySelectionActions({ managerRef, paneTransportsRef, setTerminalError, tabId })
  const { activatePaneTitleInteraction, splitTerminalPaneFromHeader, beginPaneDragFromHeader } =
    useTerminalPaneHeaderActions({
      managerRef,
      paneTransportsRef,
      paneCwdRef,
      cwd,
      worktreeId,
      tabId
    })

  return {
    getMobileOwnedTerminalPtyIds,
    scheduleRestoredTerminalRefit,
    restorePaneTerminalFit,
    restoreAllTerminalFits,
    terminalShouldHandleMiddleClick,
    handlePrimarySelectionMiddleMouseDown,
    handlePrimarySelectionAuxClick,
    activatePaneTitleInteraction,
    splitTerminalPaneFromHeader,
    beginPaneDragFromHeader
  }
}

export type TerminalPaneMobileController = TerminalPaneContextController &
  ReturnType<typeof useTerminalPaneMobileActions>
