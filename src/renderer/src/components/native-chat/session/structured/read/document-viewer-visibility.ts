import type { StructuredAgentSessionViewerVisibility } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-coalescer'

const documentHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden'

let shownCount = 0
if (typeof document !== 'undefined') {
  // Registered before any read's listener, so a reveal sees the count change before held text lands.
  document.addEventListener('visibilitychange', () => {
    if (!documentHidden()) {
      shownCount += 1
    }
  })
}

/** How many times the window has been shown again; text that lands across a change was held. */
export function documentShownCount(): number {
  return shownCount
}

/** A minimized or hidden window merges a chat's streaming text until it shows, then draws it once. */
export const documentViewerVisibility: StructuredAgentSessionViewerVisibility = {
  hidden: documentHidden,
  subscribeShown: (shown) => {
    if (typeof document === 'undefined') {
      return () => {}
    }
    const onChange = (): void => {
      if (!documentHidden()) {
        shown()
      }
    }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }
}
