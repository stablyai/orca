import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { TerminalCopyFeedbackPopup } from './TerminalCopyFeedbackPopup'
import { pruneTerminalCopyFlashLeafIds } from './terminal-copy-flash-store'
import CodexRestartChip from '../CodexRestartChip'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import { TerminalRemoteRuntimeReconnectBanner } from './TerminalRemoteRuntimeReconnectBanner'
import { TerminalProcessExitOverlay } from './TerminalProcessExitOverlay'
import { MobileDriverOverlay } from './MobileDriverOverlay'
import { getDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'
import { shouldChatTakeOverMobileSurface } from '../native-chat/native-chat-send-eligibility'
import type { TerminalPaneController } from './use-terminal-pane-controller'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

export function TerminalPaneCodexRestartPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { activePane, isActive, isVisible, managedPanes, paneTransportsRef, savedLayout } =
    controller
  return (
    <>
      {managedPanes.map((pane) => {
        const ptyId =
          paneTransportsRef.current.get(pane.id)?.getPtyId() ??
          savedLayout.ptyIdsByLeafId?.[pane.leafId]
        if (!ptyId) {
          return null
        }
        return createPortal(
          <CodexRestartChip
            key={`codex-restart-${pane.id}-${ptyId}`}
            isVisible={isVisible}
            ptyId={ptyId}
            shouldFocus={isActive && isVisible && activePane?.id === pane.id}
          />,
          pane.container,
          `codex-restart-${pane.id}`
        )
      })}
    </>
  )
}

export function TerminalPaneProcessExitPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const {
    handleCloseExitedPane,
    handleRestartExitedPane,
    isActive,
    managedPanes,
    paneProcessExitsByPaneId
  } = controller
  if (!isActive) {
    return null
  }
  return (
    <>
      {managedPanes.map((pane) => {
        const processExit = paneProcessExitsByPaneId[pane.id]
        if (!processExit) {
          return null
        }
        return createPortal(
          <TerminalProcessExitOverlay
            processExit={processExit}
            onRestart={() => handleRestartExitedPane(processExit)}
            onClose={() => handleCloseExitedPane(pane.id)}
          />,
          pane.container,
          `process-exit-${pane.id}`
        )
      })}
    </>
  )
}

export function TerminalPaneSshReconnectPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const {
    managedPanes,
    showSshReconnectOverlay,
    sshReconnectEnvironmentId,
    sshReconnectError,
    sshReconnectStatus,
    sshReconnectTargetId,
    sshReconnectTargetLabel,
    sshReconnectTargetRemoved,
    worktreeId
  } = controller
  if (!showSshReconnectOverlay || !sshReconnectTargetId || !sshReconnectStatus) {
    return null
  }
  return (
    <>
      {managedPanes.map((pane) =>
        createPortal(
          <TerminalSshReconnectOverlay
            targetId={sshReconnectTargetId}
            targetLabel={sshReconnectTargetLabel}
            status={sshReconnectStatus}
            error={sshReconnectError}
            targetRemoved={sshReconnectTargetRemoved}
            worktreeId={worktreeId}
            sshOwnerEnvironmentId={sshReconnectEnvironmentId}
          />,
          pane.container,
          `ssh-reconnect-${pane.id}`
        )
      )}
    </>
  )
}

export function TerminalPaneRecoveryPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const { managedPanes, paneTransportsRef, ptyRecoveryStatesByPaneId, showSshReconnectOverlay } =
    controller
  if (showSshReconnectOverlay) {
    return null
  }
  return (
    <>
      {managedPanes.map((pane) => {
        const recoveryState = ptyRecoveryStatesByPaneId[pane.id]
        if (!recoveryState) {
          return null
        }
        return createPortal(
          <TerminalRemoteRuntimeReconnectBanner
            key={`remote-runtime-reconnect-${pane.id}-${recoveryState.epoch}`}
            phase={recoveryState.phase}
            onReconnect={() => paneTransportsRef.current.get(pane.id)?.retryRecovery?.()}
          />,
          pane.container,
          `remote-runtime-reconnect-${pane.id}`
        )
      })}
    </>
  )
}

export function TerminalPaneMobileDriverPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const {
    chatLeafId,
    effectiveChatViewMode,
    managedPanes,
    paneTransportsRef,
    restoreAllTerminalFits,
    restorePaneTerminalFit
  } = controller
  return (
    <>
      {managedPanes.map((pane) => {
        const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
        if (!ptyId) {
          return null
        }
        const driver = getDriverForPty(ptyId)
        const fitMode = getFitOverrideForPty(ptyId)?.mode ?? null
        const hasFitOverride = fitMode === 'mobile-fit'
        if (!shouldShowMobileDriverOverlay(driver.kind, fitMode)) {
          return null
        }
        const paneSurface =
          effectiveChatViewMode && pane.leafId === chatLeafId ? 'chat' : 'terminal'
        if (shouldChatTakeOverMobileSurface(paneSurface)) {
          return null
        }
        return createPortal(
          <MobileDriverOverlay
            key={`mobile-driver-${pane.id}-${ptyId}`}
            driver={driver}
            hasFitOverride={hasFitOverride}
            rootClassName="mobile-driver-banner"
            onAction={() => restorePaneTerminalFit(pane, ptyId)}
            onAllAction={() => restoreAllTerminalFits(pane)}
          />,
          pane.container,
          `mobile-driver-banner-${pane.id}`
        )
      })}
    </>
  )
}

export function TerminalPaneCopyFeedbackPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { managedPanes } = controller
  // Key on the leafIds, not the managedPanes array identity: getPanes() returns a fresh array
  // on every call, so an array-identity dependency would fire this effect on every render
  // instead of only when panes are actually added or removed.
  const leafIdsKey = useMemo(
    () => managedPanes.map((pane) => pane.leafId).join(','),
    [managedPanes]
  )
  const previousLeafIdsRef = useRef<ReadonlySet<TerminalLeafId>>(new Set())
  // Closed panes would otherwise keep pending flash timers alive. Diffs against this surface's
  // own previous leafIds (only ever removing what this surface itself used to own) instead of
  // "keep only my current panes": the flash store is one map shared by every concurrently
  // mounted PaneManager surface, so a keep-only-mine prune would delete live state that
  // belongs to a different surface's still-open panes.
  useEffect(() => {
    const currentLeafIds = new Set(managedPanes.map((pane) => pane.leafId))
    const removedLeafIds = new Set(
      [...previousLeafIdsRef.current].filter((leafId) => !currentLeafIds.has(leafId))
    )
    previousLeafIdsRef.current = currentLeafIds
    if (removedLeafIds.size > 0) {
      pruneTerminalCopyFlashLeafIds(removedLeafIds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leafIdsKey is the change signal; managedPanes churns identity every render.
  }, [leafIdsKey])
  // On unmount (surface closed entirely), release every leafId this surface was still tracking.
  useEffect(
    () => () => {
      if (previousLeafIdsRef.current.size > 0) {
        pruneTerminalCopyFlashLeafIds(previousLeafIdsRef.current)
      }
    },
    []
  )
  return (
    <>
      {managedPanes.map((pane) =>
        createPortal(
          <TerminalCopyFeedbackPopup leafId={pane.leafId} terminal={pane.terminal} />,
          pane.container,
          `copy-feedback-${pane.leafId}`
        )
      )}
    </>
  )
}
