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
        const reason = paneIds.get(pane.id)
        if (!reason) {
          return null
        }
        return createPortal(
          // Why: resumed TUIs repaint xterm immediately, so the wake marker
          // must live in that pane's chrome instead of the PTY byte stream.
          <SessionRestoredBanner visible reason={reason} />,
          pane.container,
          `session-restored-banner-${pane.id}`
        )
      })}
    </>
  )
}
