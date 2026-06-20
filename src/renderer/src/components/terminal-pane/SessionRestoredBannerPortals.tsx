import { createPortal } from 'react-dom'
import { SessionRestoredBanner } from './SessionRestoredBanner'
import type { SessionRestoredBannerPane } from './session-restored-banner-pane-state'

type SessionRestoredBannerPortalsProps = {
  panes: readonly SessionRestoredBannerPane[]
  paneIds: ReadonlySet<number>
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
          // Why: resumed TUIs repaint xterm immediately, so the wake marker
          // must live in that pane's chrome instead of the PTY byte stream.
          <SessionRestoredBanner visible />,
          pane.container,
          `session-restored-banner-${pane.id}`
        )
      })}
    </>
  )
}
