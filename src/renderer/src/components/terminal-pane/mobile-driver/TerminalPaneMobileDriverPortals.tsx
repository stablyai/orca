import { createPortal } from 'react-dom'
import { MobileDriverOverlay } from './MobileDriverOverlay'
import { HeldPaneRemoteViewportChip } from './RemoteViewportHeldChip'
import { getDriverForPty } from '../../../lib/pane-manager/mobile-driver-state'
import { getFitOverrideForPty } from '../../../lib/pane-manager/mobile-fit-overrides'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'
import { shouldChatTakeOverMobileSurface } from '../../native-chat/host-access/native-chat-send-eligibility'
import type { TerminalPaneController } from '../controller/use-terminal-pane-controller'

export function TerminalPaneMobileDriverPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const {
    activePane,
    chatLeafId,
    effectiveChatViewMode,
    managedPanes,
    paneTransportsRef,
    restoreAllTerminalFits,
    restorePaneTerminalFit,
    searchOpen
  } = controller
  return (
    <>
      {managedPanes.map((pane) => {
        const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
        if (!ptyId) {
          return null
        }
        const driver = getDriverForPty(ptyId)
        const fitOverride = getFitOverrideForPty(ptyId)
        const fitMode = fitOverride?.mode ?? null
        const hasFitOverride = fitMode === 'mobile-fit'
        const paneSurface =
          effectiveChatViewMode && pane.leafId === chatLeafId ? 'chat' : 'terminal'
        if (!shouldShowMobileDriverOverlay(driver.kind, fitMode)) {
          // Only held terminal panes mount the measuring chip; it yields the corner to an open find bar.
          if (
            fitMode !== 'remote-desktop-fit' ||
            !fitOverride ||
            paneSurface !== 'terminal' ||
            (searchOpen && activePane?.id === pane.id)
          ) {
            return null
          }
          return createPortal(
            <HeldPaneRemoteViewportChip
              key={`remote-viewport-held-${pane.id}-${ptyId}`}
              pane={pane}
              ownerGrid={fitOverride}
              onFitHere={(grid) => {
                paneTransportsRef.current.get(pane.id)?.claimViewport?.(grid.cols, grid.rows)
                pane.terminal.focus()
              }}
            />,
            pane.container,
            `remote-viewport-held-${pane.id}`
          )
        }
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
