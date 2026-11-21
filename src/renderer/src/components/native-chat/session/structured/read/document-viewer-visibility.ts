import type { StructuredAgentSessionViewerVisibility } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-coalescer'

const documentHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden'

function subscribeDocumentShown(shown: () => void): () => void {
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

const heldDrawnBySession = new Map<string, number>()

/** How many times a chat's text held while the window was hidden has been drawn; its text landing
 *  across a change was held. */
export function documentHeldDrawnCount(sessionId: string | undefined): number {
  return sessionId === undefined ? 0 : (heldDrawnBySession.get(sessionId) ?? 0)
}

/** A minimized or hidden window merges a chat's streaming text until it shows, then draws it once. */
export function documentViewerVisibility(
  sessionId: string
): StructuredAgentSessionViewerVisibility {
  return {
    hidden: documentHidden,
    heldDrawn: () => {
      heldDrawnBySession.set(sessionId, documentHeldDrawnCount(sessionId) + 1)
    },
    subscribeShown: subscribeDocumentShown
  }
}
