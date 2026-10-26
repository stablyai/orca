import { useTerminalPaneLocalClose } from './use-terminal-pane-local-close'
import type {
  RequestActiveTerminalPaneCloseDetail,
  TerminalPaneCloseCallbacks
} from '@/constants/terminal'
import { useCallback, useEffect, useRef } from 'react'
import { onActiveTerminalPaneCloseRequest } from './request-active-terminal-pane-close'
import { useAppStore } from '../../store'
import type { PaneExternalDropTarget } from '@/lib/pane-manager/pane-manager'
import { resolveLeafCloseCopyKind } from '../terminal/terminal-close-copy-kind'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from '../terminal/running-terminal-close-guard'
import { probePtyRunningWork } from '../terminal/pty-running-work-probe'
import {
  detachTerminalPaneToTab,
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-pane-tab-detach'
import type { TerminalPaneBindingController } from './use-terminal-pane-layout-bindings'
import { capturePendingTerminalPaneClose } from './terminal-pane-close-admission'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { sendUserPaneCloseToLayoutOwner } from './layout-owner-pane-close-command'

export function useTerminalPaneCloseActions(controller: TerminalPaneBindingController) {
  const cancelCloseRef = useRef<(() => void) | undefined>(undefined)
  const confirmedCloseRef = useRef<(() => void) | null>(null)
  const {
    managerRef,
    onCloseTab,
    paneCwdRef,
    paneTransportsRef,
    pendingCloseConfirmation,
    persistLayoutSnapshot,
    setPendingCloseConfirmation,
    tabId,
    updateSettings,
    worktreeId
  } = controller
  const closePaneLocally = useTerminalPaneLocalClose(controller)
  const executeClosePane = useCallback(
    (paneId: number, callbacks?: TerminalPaneCloseCallbacks) => {
      const manager = managerRef.current
      if (!manager || callbacks?.isCurrent?.() === false) {
        callbacks?.onCancel?.()
        return
      }
      if (manager.getPanes().length <= 1) {
        onCloseTab(
          callbacks?.onConfirm
            ? {
                ...callbacks,
                onConfirm: (force) => {
                  cancelCloseRef.current = undefined
                  callbacks.onConfirm?.(force)
                }
              }
            : callbacks
        )
        return
      }
      if (callbacks?.onConfirm) {
        cancelCloseRef.current = undefined
        callbacks.onConfirm()
        return
      }
      const leafId = manager.getLeafId(paneId)
      if (!leafId) {
        callbacks?.onCancel?.()
        return
      }
      // Switch point: main closes the pane first; the window removes it when main's frame does.
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        sendUserPaneCloseToLayoutOwner(
          { worktreeId, tabId, leafId, paneId },
          {
            getManager: () => managerRef.current,
            closeTab: onCloseTab,
            closePaneLocally
          }
        )
      ) {
        return
      }
      closePaneLocally(paneId)
    },
    [closePaneLocally, onCloseTab, tabId, worktreeId, managerRef]
  )
  const getCloseDialogCopyKind = useCallback(
    (paneId: number) => resolveLeafCloseCopyKind(tabId, managerRef.current?.getLeafId(paneId)),
    [tabId, managerRef]
  )
  const handleRequestClosePane = useCallback(
    (paneId: number, callbacks?: TerminalPaneCloseCallbacks) => {
      cancelCloseRef.current?.()
      cancelCloseRef.current = undefined
      confirmedCloseRef.current = null
      if (callbacks?.signal?.aborted) {
        callbacks.onCancel?.()
        return
      }
      cancelCloseRef.current = callbacks?.onCancel
      if ((managerRef.current?.getPanes().length ?? 0) <= 1) {
        executeClosePane(paneId, callbacks)
        return
      }
      const transport = paneTransportsRef.current.get(paneId)
      const pending = capturePendingTerminalPaneClose(controller, paneId, useAppStore.getState)
      const ptyId = transport?.getPtyId() ?? pending?.ptyId
      if (!ptyId) {
        executeClosePane(paneId, callbacks)
        return
      }
      const settings = useAppStore.getState().settings
      let active = true
      let probeTimeout: ReturnType<typeof setTimeout> | undefined
      const cancel = () => {
        if (!active) {
          return
        }
        active = false
        clearTimeout(probeTimeout)
        callbacks?.signal?.removeEventListener('abort', cancel)
        cancelCloseRef.current = undefined
        confirmedCloseRef.current = null
        setPendingCloseConfirmation(null)
        callbacks?.onCancel?.()
      }
      cancelCloseRef.current = cancel
      callbacks?.signal?.addEventListener('abort', cancel, { once: true })
      const close = (): void => {
        if (!active) {
          return
        }
        active = false
        callbacks?.signal?.removeEventListener('abort', cancel)
        cancelCloseRef.current = undefined
        if ((!pending || pending.isCurrent()) && callbacks?.isCurrent?.() !== false) {
          executeClosePane(paneId, callbacks)
        } else {
          callbacks?.onCancel?.()
        }
      }
      let decided = false
      const decide = (act: () => void): void => {
        if (decided || !active) {
          return
        }
        decided = true
        act()
      }
      const confirmClose = (): void => {
        if ((pending && !pending.isCurrent()) || callbacks?.isCurrent?.() === false) {
          cancel()
          return
        }
        confirmedCloseRef.current = close
        setPendingCloseConfirmation({
          paneId,
          copyKind: getCloseDialogCopyKind(paneId)
        })
      }
      probeTimeout = setTimeout(
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

  const closeActivePane = useCallback(
    (request: RequestActiveTerminalPaneCloseDetail): void => {
      const manager = managerRef.current
      const pane = request.leafId
        ? manager?.getPanes().find((p) => manager.getLeafId(p.id) === request.leafId)
        : (manager?.getActivePane() ?? manager?.getPanes()[0])
      if (pane) {
        handleRequestClosePane(pane.id, request)
      } else {
        request.onCancel?.()
      }
    },
    [handleRequestClosePane, managerRef]
  )
  useEffect(() => {
    const stop = onActiveTerminalPaneCloseRequest(tabId, closeActivePane)
    return () => {
      stop()
      cancelCloseRef.current?.()
      cancelCloseRef.current = undefined
      confirmedCloseRef.current = null
    }
  }, [closeActivePane, tabId])
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
    [pendingCloseConfirmation, updateSettings, setPendingCloseConfirmation]
  )
  const handleCancelClose = useCallback(() => {
    cancelCloseRef.current?.()
    cancelCloseRef.current = undefined
    confirmedCloseRef.current = null
    setPendingCloseConfirmation(null)
  }, [setPendingCloseConfirmation])
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
    [worktreeId, managerRef]
  )
  const handleExternalPaneDrop = useCallback(
    (sourcePaneId: number, target: PaneExternalDropTarget): boolean => {
      if (!isTerminalTabStripDropTarget(target)) {
        return false
      }
      const sourceTransport = paneTransportsRef.current.get(sourcePaneId)
      const livePtyId = sourceTransport?.getPtyId() ?? null
      const sourcePaneCwd = paneCwdRef.current.get(sourcePaneId)
      void detachTerminalPaneToTab({
        livePtyId,
        getStore: useAppStore.getState,
        manager: managerRef.current,
        persistLayoutSnapshot,
        sourcePaneId,
        ...(sourcePaneCwd ? { sourcePaneCwd } : {}),
        sourceConnectPending: sourceTransport?.isConnectPending?.() ?? false,
        sourceTabId: tabId,
        targetGroupId: target.groupId,
        targetIndex: target.insertionIndex,
        worktreeId
      }).catch((error) => console.warn('[terminal-pane-detach] move failed', error))
      return true
    },
    [persistLayoutSnapshot, tabId, worktreeId, managerRef, paneCwdRef, paneTransportsRef]
  )

  return {
    closePaneLocally,
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
