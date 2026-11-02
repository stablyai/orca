import { createPortal } from 'react-dom'
import { SessionRestoredBanner } from './SessionRestoredBanner'
import type {
  SessionRestoredBannerPane,
  SessionRestoredBannerPaneReasons
} from './session-restored-banner-pane-state'

type SessionRestoredBannerPortalsProps = {
  panes: readonly SessionRestoredBannerPane[]
  paneIds: SessionRestoredBannerPaneReasons
}

export function SessionRestoredBannerPortals({
  panes,
  paneIds
}: SessionRestoredBannerPortalsProps): React.JSX.Element {
  return (
    <>
      {panes.map((pane) => {
        if (!paneIds.has(pane.id)) {
          return null
        }
        return createPortal(
          // Put wake markers in pane chrome because resumed TUIs immediately repaint the PTY screen.
          <SessionRestoredBanner visible />,
          pane.container,
          `session-restored-banner-${pane.id}`
        )
      })}
    </>
  )
}
