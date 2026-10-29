import { createPortal } from 'react-dom'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import CodexRestartChip from '../CodexRestartChip'
import { CodexSharedServerBanner } from './CodexSharedServerBanner'
import { ClaudeOldTerminalBanner } from './ClaudeOldTerminalBanner'
import { ClaudeDiffPanelNoticeBanner } from './ClaudeDiffPanelNoticeBanner'
import { NewerDaemonHoldBanner } from './NewerDaemonHoldBanner'
import { WslDistroStoppedHoldCard } from './WslDistroStoppedHoldCard'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import { TerminalProcessExitOverlay } from './TerminalProcessExitOverlay'
import { MobileDriverOverlay } from './MobileDriverOverlay'
import { getDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'
import { shouldChatTakeOverMobileSurface } from '../native-chat/native-chat-send-eligibility'
import type { TerminalPaneController } from './use-terminal-pane-controller'

export { TerminalPaneRecoveryPortals } from './TerminalPaneRecoveryPortals'

export function TerminalPaneCodexRestartPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const {
    activePane,
    isActive,
    isVisible,
    managedPanes,
    managerRef,
    paneTransportsRef,
    savedLayout,
    tabId
  } = controller
  return (
    <>
      {managedPanes.map((pane) => {
        // Why the saved fallback: a restored pane's transport has no pty id until it reattaches.
        const ptyId =
          paneTransportsRef.current.get(pane.id)?.getPtyId() ??
          savedLayout.ptyIdsByLeafId?.[pane.leafId]
        const holdBanner = (
          <>
            <NewerDaemonHoldBanner
              key={`newer-daemon-hold-${pane.id}-${ptyId}`}
              tabId={tabId}
              leafId={pane.leafId}
            />
            <WslDistroStoppedHoldCard
              key={`wsl-distro-stopped-hold-${pane.id}`}
              tabId={tabId}
              leafId={pane.leafId}
            />
          </>
        )
        if (!ptyId) {
          // Switch point: a server's held pane has no terminal handle to bind until it reopens.
          return ORCA_LAYOUT_OWNER_IS_MAIN
            ? createPortal(holdBanner, pane.container, `codex-restart-${pane.id}`)
            : null
        }
        return createPortal(
          <>
            <CodexRestartChip
              key={`codex-restart-${pane.id}-${ptyId}`}
              isVisible={isVisible}
              ptyId={ptyId}
              onReturnFocus={() => {
                managerRef.current?.setActivePane(pane.id, { focus: false })
                focusTerminalTabSurface(tabId, pane.leafId)
              }}
              shouldFocus={isActive && isVisible && activePane?.id === pane.id}
            />
            <CodexSharedServerBanner
              key={`codex-shared-server-${pane.id}-${ptyId}`}
              ptyId={ptyId}
              tabId={tabId}
              leafId={pane.leafId}
            />
            <ClaudeOldTerminalBanner
              key={`claude-old-terminal-${pane.id}-${ptyId}`}
              ptyId={ptyId}
              tabId={tabId}
              leafId={pane.leafId}
            />
            <ClaudeDiffPanelNoticeBanner
              key={`claude-diff-panel-notice-${pane.id}-${ptyId}`}
              ptyId={ptyId}
              tabId={tabId}
              leafId={pane.leafId}
              container={pane.container}
            />
            {holdBanner}
          </>,
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
