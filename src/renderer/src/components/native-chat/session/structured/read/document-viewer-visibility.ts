import type { StructuredAgentSessionViewerVisibility } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-coalescer'
import type { StructuredAgentSessionLiveTextViewer } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-live-text-viewer'
import type { StructuredAgentSessionReplyTextInterest } from './structured-agent-session-read-owner-contract'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '@/lib/window-activity/window-park-visibility'

// The window's recovered visibility: macOS can latch the document hidden after display sleep, and
// real input then proves it shown.
const documentHidden = (): boolean => typeof document !== 'undefined' && !getWindowParkVisible()

function subscribeDocumentShown(shown: () => void): () => void {
  if (typeof document === 'undefined') {
    return () => {}
  }
  return subscribeWindowParkVisibility(() => {
    if (!documentHidden()) {
      shown()
    }
  })
}

const heldDrawnBySession = new Map<string, number>()
/** Chats whose catch-up counts are kept; a chat past this is long closed, and at worst one reply of
 *  it draws its next words at once. */
const HELD_DRAWN_CHATS_KEPT = 64

/** How many times a chat's text held while the window was hidden has been drawn; its text landing
 *  across a change was held. */
export function documentHeldDrawnCount(sessionId: string | undefined): number {
  return sessionId === undefined ? 0 : (heldDrawnBySession.get(sessionId) ?? 0)
}

/** A minimized or hidden window merges a chat's streaming text until it shows, then draws it once. */
export function documentViewerVisibility(
  sessionId: string,
  sendsShownTail?: () => boolean
): StructuredAgentSessionViewerVisibility {
  return {
    ...(sendsShownTail ? { sendsShownTail } : {}),
    hidden: documentHidden,
    heldDrawn: () => {
      const count = documentHeldDrawnCount(sessionId) + 1
      heldDrawnBySession.delete(sessionId)
      heldDrawnBySession.set(sessionId, count)
      if (heldDrawnBySession.size > HELD_DRAWN_CHATS_KEPT) {
        heldDrawnBySession.delete(heldDrawnBySession.keys().next().value!)
      }
    },
    subscribeShown: subscribeDocumentShown
  }
}

/** A read runs only while a view of its chat is shown in a tab, so its window's visibility is
 *  whether the chat is on screen; it takes live text only while a reader draws reply text. */
export function documentLiveTextViewer(
  supported: StructuredAgentSessionLiveTextViewer['supported'],
  setShown: StructuredAgentSessionLiveTextViewer['setShown'],
  replyText?: StructuredAgentSessionReplyTextInterest
): StructuredAgentSessionLiveTextViewer {
  return {
    supported,
    shown: () => !documentHidden() && (replyText?.shown() ?? true),
    subscribeShown: (changed) => {
      const stopWindow =
        typeof document === 'undefined' ? () => {} : subscribeWindowParkVisibility(changed)
      const stopReaders = replyText?.subscribe(changed) ?? (() => {})
      return () => {
        stopWindow()
        stopReaders()
      }
    },
    setShown
  }
}
