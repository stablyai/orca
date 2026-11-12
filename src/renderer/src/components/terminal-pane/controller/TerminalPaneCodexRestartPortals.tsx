import { Fragment } from 'react'
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
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { PaneBannerPortal } from '../chat/PaneBannerPortal'

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
        const paneKey = makePaneKey(tabId, pane.leafId)
        const holdCard = (
          <WslDistroStoppedHoldCard
            key={`wsl-distro-stopped-hold-${pane.id}`}
            tabId={tabId}
            leafId={pane.leafId}
          />
        )
        const holdBanner = (
          <NewerDaemonHoldBanner
            key={`newer-daemon-hold-${pane.id}-${ptyId}`}
            tabId={tabId}
            leafId={pane.leafId}
          />
        )
        if (!ptyId) {
          // Switch point: a server's held pane has no terminal handle to bind until it reopens.
          return ORCA_LAYOUT_OWNER_IS_MAIN ? (
            <Fragment key={pane.id}>
              {createPortal(holdCard, pane.container, `codex-restart-${pane.id}`)}
              <PaneBannerPortal pane={pane} paneKey={paneKey} portalKey={`pane-banners-${pane.id}`}>
                {holdBanner}
              </PaneBannerPortal>
            </Fragment>
          ) : null
        }
        return (
          <Fragment key={pane.id}>
            {createPortal(
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
                {/* About the terminal itself (Claude's own diff panel), so it stays on the pane. */}
                <ClaudeDiffPanelNoticeBanner
                  key={`claude-diff-panel-notice-${pane.id}-${ptyId}`}
                  ptyId={ptyId}
                  tabId={tabId}
                  leafId={pane.leafId}
                  container={pane.container}
                />
                {holdCard}
              </>,
              pane.container,
              `codex-restart-${pane.id}`
            )}
            {/* About the pane's agent or process: shown in the chat column while its chat view is open. */}
            <PaneBannerPortal pane={pane} paneKey={paneKey} portalKey={`pane-banners-${pane.id}`}>
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
              <WorkerAutoCloseBanner
                key={`worker-auto-close-${pane.id}`}
                tabId={tabId}
                leafId={pane.leafId}
                worktreeId={worktreeId}
                isVisible={isVisible}
              />
              {holdBanner}
            </PaneBannerPortal>
          </Fragment>
        )
      })}
    </>
  )
}
