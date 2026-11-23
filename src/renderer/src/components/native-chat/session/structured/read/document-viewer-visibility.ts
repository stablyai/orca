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

// Per chat, its drawn streaming replies and those drawn only at their saves, each counted per
// drawing (a chat can show in two panes), and who to tell when either changes.
const streamingRows = new Map<string, Map<string, number>>()
const savesOnlyRows = new Map<string, Map<string, number>>()
const savesOnlyWatchers = new Map<string, Set<() => void>>()

function countRow(
  rows: Map<string, Map<string, number>>,
  sessionId: string,
  rowKey: string
): () => void {
  const counts = rows.get(sessionId) ?? new Map<string, number>()
  counts.set(rowKey, (counts.get(rowKey) ?? 0) + 1)
  rows.set(sessionId, counts)
  savesOnlyWatchers.get(sessionId)?.forEach((changed) => changed())
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const left = (counts.get(rowKey) ?? 1) - 1
    if (left > 0) {
      counts.set(rowKey, left)
    } else {
      counts.delete(rowKey)
    }
    if (counts.size === 0 && rows.get(sessionId) === counts) {
      rows.delete(sessionId)
    }
    savesOnlyWatchers.get(sessionId)?.forEach((changed) => changed())
  }
}

/** A drawn streaming reply of a chat. Returns the release. */
export function documentRowStreams(sessionId: string, rowKey: string): () => void {
  return countRow(streamingRows, sessionId, rowKey)
}

/** A streaming reply that fell back to its saves. When every streaming reply its chat draws has,
 *  the chat takes no live text, so the host sends what it would discard no more. */
export function documentRowShowsSavesOnly(sessionId: string, rowKey: string): () => void {
  return countRow(savesOnlyRows, sessionId, rowKey)
}

export function documentShowsSavesOnly(sessionId: string): boolean {
  const savesOnly = savesOnlyRows.get(sessionId)
  if (!savesOnly || savesOnly.size === 0) {
    return false
  }
  // Another drawn reply still streaming live keeps the chat's live text.
  for (const rowKey of streamingRows.get(sessionId)?.keys() ?? []) {
    if (!savesOnly.has(rowKey)) {
      return false
    }
  }
  return true
}

export function subscribeDocumentSavesOnly(sessionId: string, changed: () => void): () => void {
  const watchers = savesOnlyWatchers.get(sessionId) ?? new Set<() => void>()
  watchers.add(changed)
  savesOnlyWatchers.set(sessionId, watchers)
  return () => {
    watchers.delete(changed)
    if (watchers.size === 0 && savesOnlyWatchers.get(sessionId) === watchers) {
      savesOnlyWatchers.delete(sessionId)
    }
  }
}

/** A chat's reply-text interest, withdrawn while one of its streaming replies shows only saves. */
export function withDocumentSavesOnly(
  sessionId: string,
  readers: StructuredAgentSessionReplyTextInterest
): StructuredAgentSessionReplyTextInterest {
  return {
    shown: () => !documentShowsSavesOnly(sessionId) && readers.shown(),
    subscribe: (changed) => {
      const stopReaders = readers.subscribe(changed)
      const stopSavesOnly = subscribeDocumentSavesOnly(sessionId, changed)
      return () => {
        stopReaders()
        stopSavesOnly()
      }
    }
  }
}
