import type { StructuredAgentSessionViewerVisibility } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-coalescer'

const documentHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden'

let heldDrawnCount = 0

/** How many times text held while the window was hidden has been drawn; text landing across a change was held. */
export function documentHeldDrawnCount(): number {
  return heldDrawnCount
}

/** A minimized or hidden window merges a chat's streaming text until it shows, then draws it once. */
export const documentViewerVisibility: StructuredAgentSessionViewerVisibility = {
  hidden: documentHidden,
  heldDrawn: () => {
    heldDrawnCount += 1
  },
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
