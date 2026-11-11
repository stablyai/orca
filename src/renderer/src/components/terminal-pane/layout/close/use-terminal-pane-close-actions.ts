import { captureTerminalPaneNoticeRetirement } from '../../mounting/terminal-pane-notice-retirement'
import { useTerminalSelectionSearch } from '../../search/use-terminal-selection-search'
import { useCallback, useEffect, useRef } from 'react'
import { onActiveTerminalPaneCloseRequest } from './request-active-terminal-pane-close'
import { useAppStore } from '../../../../store/index'
import { retireUnboundRuntimeTerminalPane } from './retire-unbound-runtime-terminal-pane'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { closeWebRuntimeTerminal } from '@/runtime/hosted-terminals/actions/web-runtime-terminal-close'
import { resolveLeafCloseCopyKind } from '../../../terminal/terminal-close-copy-kind'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from '../../../terminal/running-terminal-close-guard'
import { probePtyRunningWork } from '../../../terminal/pty-running-work-probe'
import { clearPaneTerminalError } from '../../errors/terminal-error-accumulation'
import type { TerminalPaneBindingController } from '../ownership/use-terminal-pane-layout-bindings'
import { retireUnboundIpcTerminalPane } from './retire-unbound-ipc-terminal-pane'
import { capturePendingTerminalPaneClose } from './terminal-pane-close-admission'
import { commitTerminalSurfaceClose } from '@/store/terminals/terminal-surface-close-intent'
import { noteAgentLaunchPaneClosedByUser } from '../../../../lib/agent-session/launch/pane/agent-launch-pane-closes'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { sendUserPaneCloseToLayoutOwner } from './layout-owner-pane-close-command'
import type { TerminalTabCloseIntent } from '../../../terminal/terminal-tab-close-intent'
import type { useTerminalPaneTabDetachActions } from '../detach/use-terminal-pane-tab-detach-actions'

export function useTerminalPaneCloseActions(controller: TerminalPaneBindingController) {
  const confirmedCloseRef = useRef<(() => void) | null>(null)
  const {
    clearSessionRestoredBannerForPane,
    managerRef,
    onCloseTab,
    paneTransportsRef,
    pendingCloseConfirmation,
    setPendingCloseConfirmation,
    setTerminalErrorsByPaneId,
    syncPanePtyLayoutBinding,
    syncPanePtyLayoutBindingForLeaf,
    tabId,
    updateSettings,
    worktreeId
  } = controller
  // The window's half of a split pane's close: its transport, status and pane go.
  const closePaneLocally = useCallback(
    (paneId: number, committedLeafId: string | undefined, reason: TerminalTabCloseIntent) => {
      const manager = managerRef.current
      // Why the pane check: main's answer can land after the pane already went.
      if (!manager || (committedLeafId && manager.getLeafId(paneId) !== committedLeafId)) {
        return
      }
      // A sibling went while main answered: this pane is now the tab's last, so its close closes the tab.
      if (committedLeafId && manager.getPanes().length <= 1) {
        onCloseTab(reason)
        return
      }
      const ptyId = paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
      closeWebRuntimeTerminal(ptyId, worktreeId)
      clearSessionRestoredBannerForPane(paneId)
      const leafId = manager.getLeafId(paneId)
      if (leafId) {
        useAppStore.getState().terminalStartupAttempt?.close(tabId, leafId)
        const launchPane = useAppStore
          .getState()
          .tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.agentLaunchPane
        if (reason === 'user' && launchPane?.leafId === leafId && !launchPane.outcome) {
          // The user closed a launch pane whose agent is still starting; main stops that launch.
          noteAgentLaunchPaneClosedByUser(tabId, leafId)
        }
        if (!committedLeafId) {
          commitTerminalSurfaceClose(worktreeId, { kind: 'pane', tabId, leafId })
        }
        retireUnboundIpcTerminalPane({
          getState: useAppStore.getState,
          tabId,
          leafId,
          transport: paneTransportsRef.current.get(paneId),
          getTransports: () => paneTransportsRef.current
        })
        useAppStore.getState().setCacheTimerStartedAt(makePaneKey(tabId, leafId), null)
        useAppStore.getState().dropAgentStatus(makePaneKey(tabId, leafId), { paneRemoved: true })
      }
      setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId))
      if (leafId) {
        retireUnboundRuntimeTerminalPane({
          getState: useAppStore.getState,
          tabId,
          leafId,
          transport: paneTransportsRef.current.get(paneId),
          getTransports: () => paneTransportsRef.current
        })
        syncPanePtyLayoutBindingForLeaf?.(leafId, null, paneId)
      } else {
        syncPanePtyLayoutBinding(paneId, null)
      }
      manager.closePane(paneId)
    },
    [
      clearSessionRestoredBannerForPane,
      onCloseTab,
      syncPanePtyLayoutBinding,
      syncPanePtyLayoutBindingForLeaf,
      tabId,
      worktreeId,
      managerRef,
      paneTransportsRef,
      setTerminalErrorsByPaneId
    ]
  )
  const executeClosePane = useCallback(
    (paneId: number, reason: TerminalTabCloseIntent) => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      if (manager.getPanes().length <= 1) {
        onCloseTab(reason)
        return
      }
      const leafId = manager.getLeafId(paneId)
      const transport = paneTransportsRef.current.get(paneId)
      const retireNotice = leafId
        ? captureTerminalPaneNoticeRetirement({
            tabId,
            worktreeId,
            leafId,
            transport,
            ptyId:
              transport?.getPtyId() ??
              useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId],
            getTransports: () => paneTransportsRef.current
          })
        : undefined
      // Switch point: main closes the pane first; the window removes it when main's frame does.
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        leafId &&
        sendUserPaneCloseToLayoutOwner(
          { worktreeId, tabId, leafId, paneId },
          {
            onAcceptedClose: retireNotice,
            getManager: () => managerRef.current,
            closeTab: () => onCloseTab(reason),
            closePaneLocally: (id, committedLeafId) => closePaneLocally(id, committedLeafId, reason)
          }
        )
      ) {
        return
      }
      closePaneLocally(paneId, undefined, reason)
    },
    [closePaneLocally, onCloseTab, tabId, worktreeId, managerRef, paneTransportsRef]
  )
  const getCloseDialogCopyKind = useCallback(
    (paneId: number) => resolveLeafCloseCopyKind(tabId, managerRef.current?.getLeafId(paneId)),
    [tabId, managerRef]
  )
  const handleRequestClosePane = useCallback(
    (paneId: number) => {
      if ((managerRef.current?.getPanes().length ?? 0) <= 1) {
        executeClosePane(paneId, 'user')
        return
      }
      const transport = paneTransportsRef.current.get(paneId)
      const pending = capturePendingTerminalPaneClose(controller, paneId, useAppStore.getState)
      const ptyId = transport?.getPtyId() ?? pending?.ptyId
      if (!ptyId) {
        executeClosePane(paneId, 'user')
        return
      }
      const settings = useAppStore.getState().settings
      const close = (): void => {
        if (!pending || pending.isCurrent()) {
          executeClosePane(paneId, 'user')
        }
      }
      let decided = false
      const decide = (act: () => void): void => {
        if (decided) {
          return
        }
        decided = true
        act()
      }
      const confirmClose = (): void => {
        if (pending && !pending.isCurrent()) {
          return
        }
        confirmedCloseRef.current = close
        setPendingCloseConfirmation({
          paneId,
          copyKind: getCloseDialogCopyKind(paneId)
        })
      }
      const probeTimeout = setTimeout(
        () =>
          decide(
            pending && settings?.skipCloseTerminalWithRunningProcessConfirm ? close : confirmClose
          ),
        RUNNING_CLOSE_PROBE_TIMEOUT_MS
      )
      // Reuse tab-close admission so unanswered-host behavior cannot drift between split and tab closes.
      void probePtyRunningWork([ptyId], { timeoutMs: RUNNING_CLOSE_PROBE_TIMEOUT_MS })
        .then((probes) => {
          clearTimeout(probeTimeout)
          decide(() => {
            if (
              probes[0]?.verdict === 'exited' ||
              settings?.skipCloseTerminalWithRunningProcessConfirm
            ) {
              close()
            } else {
              confirmClose()
            }
          })
        })
        .catch(() => {
          clearTimeout(probeTimeout)
          decide(
            pending && !settings?.skipCloseTerminalWithRunningProcessConfirm ? confirmClose : close
          )
        })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [executeClosePane, getCloseDialogCopyKind]
  )

  const closeActivePane = useCallback((): void => {
    const manager = managerRef.current
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    if (pane) {
      handleRequestClosePane(pane.id)
    }
  }, [handleRequestClosePane, managerRef])
  useEffect(
    () => onActiveTerminalPaneCloseRequest(tabId, closeActivePane),
    [closeActivePane, tabId]
  )
  const { handleSearchSelectedText } = useTerminalSelectionSearch()
  const handleConfirmClose = useCallback(
    (dontAskAgain: boolean) => {
      if (pendingCloseConfirmation === null || confirmedCloseRef.current === null) {
        return
      }
      const confirmedClose = confirmedCloseRef.current
      confirmedCloseRef.current = null
      setPendingCloseConfirmation(null)
      if (dontAskAgain) {
        void updateSettings({
          skipCloseTerminalWithRunningProcessConfirm: true
        })
      }
      confirmedClose()
    },
    [pendingCloseConfirmation, updateSettings, setPendingCloseConfirmation]
  )
  const handleCancelClose = useCallback(() => {
    confirmedCloseRef.current = null
    setPendingCloseConfirmation(null)
  }, [setPendingCloseConfirmation])

  return {
    closePaneLocally,
    executeClosePane,
    getCloseDialogCopyKind,
    handleRequestClosePane,
    handleSearchSelectedText,
    handleConfirmClose,
    handleCancelClose
  }
}

export type TerminalPaneCloseController = TerminalPaneBindingController &
  ReturnType<typeof useTerminalPaneCloseActions> &
  ReturnType<typeof useTerminalPaneTabDetachActions>
