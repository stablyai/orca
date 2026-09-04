import { useCallback, useImperativeHandle } from 'react'
import { useAppStore } from '../../store'
import type { PaneExternalDropTarget } from '@/lib/pane-manager/pane-manager'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { closeWebRuntimeTerminal } from '@/runtime/web-runtime-session'
import { resolveLeafCloseCopyKind } from '../terminal/terminal-close-copy-kind'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from '../terminal/running-terminal-close-guard'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import {
  detachTerminalPaneToTab,
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-pane-tab-detach'
import { clearPaneTerminalError } from './terminal-error-accumulation'
import type { TerminalPaneBindingController } from './use-terminal-pane-layout-bindings'

export function useTerminalPaneCloseActions(controller: TerminalPaneBindingController) {
  const {
    clearSessionRestoredBannerForPane,
    managerRef,
    onCloseTab,
    paneCwdRef,
    paneTransportsRef,
    pendingCloseConfirmation,
    persistLayoutSnapshot,
    ref,
    setPendingCloseConfirmation,
    setTerminalErrorsByPaneId,
    syncPanePtyLayoutBinding,
    syncPanePtyLayoutBindingForLeaf,
    tabId,
    updateSettings,
    worktreeId
  } = controller
  const executeClosePane = useCallback(
    (paneId: number) => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      if (manager.getPanes().length <= 1) {
        onCloseTab()
      } else {
        const ptyId = paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
        closeWebRuntimeTerminal(ptyId)
        clearSessionRestoredBannerForPane(paneId)
        const leafId = manager.getLeafId(paneId)
        if (leafId) {
          useAppStore.getState().setCacheTimerStartedAt(makePaneKey(tabId, leafId), null)
          useAppStore.getState().dropAgentStatus(makePaneKey(tabId, leafId), { paneRemoved: true })
        }
        setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId))
        if (leafId) {
          syncPanePtyLayoutBindingForLeaf?.(leafId, null, paneId)
        } else {
          syncPanePtyLayoutBinding(paneId, null)
        }
        manager.closePane(paneId)
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [
      clearSessionRestoredBannerForPane,
      onCloseTab,
      syncPanePtyLayoutBinding,
      syncPanePtyLayoutBindingForLeaf,
      tabId
    ]
  )
  const getCloseDialogCopyKind = useCallback(
    (paneId: number) => resolveLeafCloseCopyKind(tabId, managerRef.current?.getLeafId(paneId)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [tabId]
  )
  const handleRequestClosePane = useCallback(
    (paneId: number) => {
      if ((managerRef.current?.getPanes().length ?? 0) <= 1) {
        executeClosePane(paneId)
        return
      }
      const transport = paneTransportsRef.current.get(paneId)
      const ptyId = transport?.getPtyId()
      if (!ptyId) {
        executeClosePane(paneId)
        return
      }
      const settings = useAppStore.getState().settings
      let decided = false
      const decide = (act: () => void): void => {
        if (decided) {
          return
        }
        decided = true
        act()
      }
      const confirmClose = (): void =>
        setPendingCloseConfirmation({
          paneId,
          copyKind: getCloseDialogCopyKind(paneId)
        })
      const probeTimeout = setTimeout(() => decide(confirmClose), RUNNING_CLOSE_PROBE_TIMEOUT_MS)
      void inspectRuntimeTerminalProcess(settings, ptyId)
        .then((process) => {
          clearTimeout(probeTimeout)
          decide(() => {
            if (
              !process.hasChildProcesses ||
              settings?.skipCloseTerminalWithRunningProcessConfirm
            ) {
              executeClosePane(paneId)
            } else {
              confirmClose()
            }
          })
        })
        .catch(() => {
          clearTimeout(probeTimeout)
          decide(() => executeClosePane(paneId))
        })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [executeClosePane, getCloseDialogCopyKind]
  )

  useImperativeHandle(
    ref,
    () => ({
      closeActivePane: (): void => {
        const manager = managerRef.current
        const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
        if (pane) {
          handleRequestClosePane(pane.id)
        }
      }
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [handleRequestClosePane]
  )
  const handleSearchSelectedText = useCallback((selectedText: string): void => {
    useAppStore.getState().showRightSidebarSearch({ query: selectedText })
  }, [])
  const handleConfirmClose = useCallback(
    (dontAskAgain: boolean) => {
      if (pendingCloseConfirmation === null) {
        return
      }
      const paneId = pendingCloseConfirmation.paneId
      setPendingCloseConfirmation(null)
      if (dontAskAgain) {
        void updateSettings({
          skipCloseTerminalWithRunningProcessConfirm: true
        })
      }
      executeClosePane(paneId)
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [executeClosePane, pendingCloseConfirmation, updateSettings]
  )
  const handleCancelClose = useCallback(() => {
    setPendingCloseConfirmation(null)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [])
  const resolveExternalPaneDropTarget = useCallback(
    ({
      sourcePaneId,
      clientX,
      clientY
    }: {
      sourcePaneId: number
      clientX: number
      clientY: number
    }) => {
      const panes = managerRef.current?.getPanes() ?? []
      if (panes.length <= 1 || !panes.some((pane) => pane.id === sourcePaneId)) {
        return null
      }
      return resolveTerminalTabStripDropTarget({
        clientX,
        clientY,
        groupsByWorktree: useAppStore.getState().groupsByWorktree,
        worktreeId
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [worktreeId]
  )
  const handleExternalPaneDrop = useCallback(
    (sourcePaneId: number, target: PaneExternalDropTarget): boolean => {
      if (!isTerminalTabStripDropTarget(target)) {
        return false
      }
      const fallbackPtyId = paneTransportsRef.current.get(sourcePaneId)?.getPtyId() ?? null
      const sourcePaneCwd = paneCwdRef.current.get(sourcePaneId)
      return (
        detachTerminalPaneToTab({
          fallbackPtyId,
          getStore: useAppStore.getState,
          manager: managerRef.current,
          persistLayoutSnapshot,
          sourcePaneId,
          ...(sourcePaneCwd ? { sourcePaneCwd } : {}),
          sourceTabId: tabId,
          targetGroupId: target.groupId,
          targetIndex: target.insertionIndex,
          worktreeId
        }) !== null
      )
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [persistLayoutSnapshot, tabId, worktreeId]
  )

  return {
    executeClosePane,
    getCloseDialogCopyKind,
    handleRequestClosePane,
    handleSearchSelectedText,
    handleConfirmClose,
    handleCancelClose,
    resolveExternalPaneDropTarget,
    handleExternalPaneDrop
  }
}

export type TerminalPaneCloseController = TerminalPaneBindingController &
  ReturnType<typeof useTerminalPaneCloseActions>
