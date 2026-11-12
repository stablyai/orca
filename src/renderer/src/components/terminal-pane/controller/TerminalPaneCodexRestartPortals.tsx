import { createPortal } from 'react-dom'
import { focusTerminalTabSurface } from '../input/focus/focus-terminal-tab-surface'
import CodexRestartChip from '../../CodexRestartChip'
import { CodexSharedServerBanner } from '../provider-notices/codex-server-isolation/CodexSharedServerBanner'
import { ClaudeOldTerminalBanner } from '../provider-notices/claude-account-shell/ClaudeOldTerminalBanner'
import { ClaudeDiffPanelNoticeBanner } from '../provider-notices/claude-diff-panel/ClaudeDiffPanelNoticeBanner'
import { NewerDaemonHoldBanner } from '../session-restore/newer-daemon/NewerDaemonHoldBanner'
import { WorkerAutoCloseBanner } from '../worker-lifetime/WorkerAutoCloseBanner'
import { WslDistroStoppedHoldCard } from '../session-restore/wsl-distro/WslDistroStoppedHoldCard'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { TerminalPaneController } from './use-terminal-pane-controller'

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
    tabId,
    worktreeId
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
            <WorkerAutoCloseBanner
              key={`worker-auto-close-${pane.id}`}
              tabId={tabId}
              leafId={pane.leafId}
              worktreeId={worktreeId}
              isVisible={isVisible}
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
