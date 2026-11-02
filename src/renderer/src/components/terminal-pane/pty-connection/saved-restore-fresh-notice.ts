// Main announces a saved restore's fresh start only after the pane's own shell committed to it.
// Both the host window's IPC and a paired host's event stream deliver here; nothing is replayed,
// so a reload or reattach can never show an earlier start's notice.

import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import type { TerminalSavedRestoreFreshEvent } from '../../../../../shared/runtime-client-events'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export type SavedRestoreFreshNotice = Omit<TerminalSavedRestoreFreshEvent, 'type'>

type Viewer = (notice: SavedRestoreFreshNotice) => void

// Dispatch ids are unique per start; this only absorbs a twin delivery, so a short memory suffices.
const MAX_SEEN_DISPATCHES = 256
const seenDispatches = new Set<string>()
const viewers = new Set<Viewer>()
let channelUnsubscribe: (() => void) | null = null

export function dispatchSavedRestoreFreshNotice(notice: SavedRestoreFreshNotice): void {
  if (seenDispatches.has(notice.dispatchId)) {
    return
  }
  for (const viewer of viewers) {
    viewer(notice)
  }
}

/** False when this document already showed the dispatch. */
function noteShown(dispatchId: string): boolean {
  if (seenDispatches.has(dispatchId)) {
    return false
  }
  seenDispatches.add(dispatchId)
  for (const oldest of seenDispatches) {
    if (seenDispatches.size <= MAX_SEEN_DISPATCHES) {
      break
    }
    seenDispatches.delete(oldest)
  }
  return true
}

function ensureWindowChannel(): void {
  if (channelUnsubscribe !== null) {
    return
  }
  // Older preloads and test surfaces lack the listener; their panes keep the create-result notice.
  const subscribe = (globalThis as { window?: Window }).window?.api?.runtime
    ?.onTerminalSavedRestoreFresh
  if (typeof subscribe === 'function') {
    channelUnsubscribe = subscribe(dispatchSavedRestoreFreshNotice)
  }
}

/** Shows the existing started-fresh overlay once for a fresh start of exactly this pane's process. */
export function installSavedRestoreFreshNotice(session: ConnectPanePtySession): void {
  ensureWindowChannel()
  // One notice that beat its own create reply; only that attempt's new process may take it.
  let pending: SavedRestoreFreshNotice | null = null
  const isCurrent = (): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
  const isThisPane = (notice: SavedRestoreFreshNotice): boolean =>
    // Why the leaf: a paired client names the host's tab differently; leaf ids are stable everywhere.
    parsePaneKey(notice.paneKey)?.leafId === session.pane.leafId &&
    (!notice.launchToken || !session.launchToken || notice.launchToken === session.launchToken)
  const isThisProcess = (notice: SavedRestoreFreshNotice, ptyId: string): boolean =>
    notice.ptyId === ptyId &&
    (notice.incarnationId ?? null) === (session.remotePtyIncarnationId ?? null)
  const show = (notice: SavedRestoreFreshNotice): void => {
    if (noteShown(notice.dispatchId)) {
      session.deps.onShowSessionRestoredBanner(session.pane.id, 'resume-unavailable')
    }
  }
  const viewer: Viewer = (notice) => {
    if (!isCurrent() || !isThisPane(notice)) {
      return
    }
    const bound: string | null = session.transport.getPtyId()
    if (bound && isThisProcess(notice, bound)) {
      show(notice)
    } else {
      // Possibly ahead of its own create reply, which settles it below.
      pending = notice
    }
  }
  viewers.add(viewer)
  session.waitTeardowns.push(() => {
    viewers.delete(viewer)
    pending = null
  })
  /** A create attempt's start (null) or reply: an adopted or reattached process takes nothing. */
  session.settleSavedRestoreFreshNotice = (createdPtyId: string | null): void => {
    const notice = pending
    pending = null
    if (notice && createdPtyId && isCurrent() && isThisProcess(notice, createdPtyId)) {
      show(notice)
    }
  }
}
