import { useCallback, useImperativeHandle, useRef } from 'react'
import { useAppStore } from '../../store'
import { retireUnboundRuntimeTerminalPane } from './retire-unbound-runtime-terminal-pane'
import type { PaneExternalDropTarget } from '@/lib/pane-manager/pane-manager'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { closeWebRuntimeTerminal } from '@/runtime/web-runtime-session'
import { resolveLeafCloseCopyKind } from '../terminal/terminal-close-copy-kind'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from '../terminal/running-terminal-close-guard'
import { probePtyRunningWork } from '../terminal/pty-running-work-probe'
import {
  detachTerminalPaneToTab,
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-pane-tab-detach'
import { clearPaneTerminalError } from './terminal-error-accumulation'
import type { TerminalPaneBindingController } from './use-terminal-pane-layout-bindings'
import { retireUnboundIpcTerminalPane } from './retire-unbound-ipc-terminal-pane'
import { capturePendingTerminalPaneClose } from './terminal-pane-close-admission'
import { commitTerminalSurfaceClose } from '@/store/terminals/terminal-surface-close-intent'

export function useTerminalPaneCloseActions(controller: TerminalPaneBindingController) {
  const confirmedCloseRef = useRef<(() => void) | null>(null)
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
          commitTerminalSurfaceClose({ worktreeId, tabId, leafId })
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
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [
      clearSessionRestoredBannerForPane,
      onCloseTab,
      syncPanePtyLayoutBinding,
      syncPanePtyLayoutBindingForLeaf,
      tabId,
      worktreeId
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
      const pending = capturePendingTerminalPaneClose(controller, paneId, useAppStore.getState)
      const ptyId = transport?.getPtyId() ?? pending?.ptyId
      if (!ptyId) {
        executeClosePane(paneId)
        return
      }
      const settings = useAppStore.getState().settings
      const close = (): void => {
        if (!pending || pending.isCurrent()) {
          executeClosePane(paneId)
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
      // Why the shared probe rather than a direct inspect: this is the same question the tab-close
      // guard asks, and the two must not drift on what an unanswered host means.
      void probePtyRunningWork(settings, [ptyId], { timeoutMs: RUNNING_CLOSE_PROBE_TIMEOUT_MS })
        .then((probes) => {
          clearTimeout(probeTimeout)
          decide(() => {
            if (
              (pending ? probes[0]?.verdict === 'exited' : probes[0]?.verdict !== 'live') ||
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [executeClosePane, pendingCloseConfirmation, updateSettings]
  )
  const handleCancelClose = useCallback(() => {
    confirmedCloseRef.current = null
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
