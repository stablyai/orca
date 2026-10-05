import { formatPanePresentationToken } from '../../../../../shared/terminal-pane-presentation-token'

/**
 * Presentation intents for a terminal tab: what may supersede a delayed agent-exit retirement or
 * cancel an in-flight composer action. Advanced only by an accepted view/owner switch (same value
 * included); a pane's rebinding changes its token through the bound PTY. Never advanced by an
 * exit's own effects (hint clears), title/geometry writes, sibling panes or a reload's hydration.
 */
export type TerminalPresentationStamp = {
  revision: number
  /** Wall clock of the last intent; same-machine exit observations compare against it. */
  changedAtMs: number
}

// Why random: tokens published before a renderer reload must never match the new store's revisions.
const PRESENTATION_EPOCH = Math.random().toString(36).slice(2, 10)
// Why bounded: entries exist only for tabs a user or client acted on; evicting one only re-fences it.
const MAX_TRACKED_TABS = 1_024
const EMPTY_STAMP: TerminalPresentationStamp = { revision: 0, changedAtMs: 0 }
const stampsByTabId = new Map<string, TerminalPresentationStamp>()
let intentRevision = 0

/** An accepted user/client switch, even to the value already shown, orders after older exits. */
export function noteTerminalPresentationIntent(tabId: string, nowMs = Date.now()): void {
  const current = stampsByTabId.get(tabId) ?? EMPTY_STAMP
  stampsByTabId.delete(tabId)
  stampsByTabId.set(tabId, {
    revision: current.revision + 1,
    changedAtMs: Math.max(nowMs, current.changedAtMs)
  })
  intentRevision += 1
  if (stampsByTabId.size > MAX_TRACKED_TABS) {
    const oldest = stampsByTabId.keys().next().value
    if (oldest !== undefined) {
      stampsByTabId.delete(oldest)
    }
  }
}

export function readTerminalPresentationStamp(tabId: string): TerminalPresentationStamp {
  return stampsByTabId.get(tabId) ?? EMPTY_STAMP
}

/** The token this store publishes for one pane of `tabId`, bound to `boundPtyId`. */
export function readTerminalPresentationToken(
  tabId: string,
  boundPtyId: string | null | undefined
): string {
  return formatPanePresentationToken(
    PRESENTATION_EPOCH,
    readTerminalPresentationStamp(tabId).revision,
    boundPtyId
  )
}

/** Advances with every intent anywhere: a cached publication built before it holds stale tokens. */
export function readTerminalPresentationIntentRevision(): number {
  return intentRevision
}

export function resetTerminalPresentationStampsForTest(): void {
  stampsByTabId.clear()
}
