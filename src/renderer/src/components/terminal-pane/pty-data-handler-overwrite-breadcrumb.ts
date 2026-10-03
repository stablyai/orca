import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { isPtyDataHandlerShutdownPending, ptyDataHandlers } from './pty-shutdown-data-suspension'

type PtyDataHandler = NonNullable<ReturnType<typeof ptyDataHandlers.get>>

/** One token per pane session; compared by identity, never by content. */
export type PtyDataHandlerPaneOwner = { readonly kind: 'pty-data-handler-pane-owner' }

export function createPtyDataHandlerPaneOwner(): PtyDataHandlerPaneOwner {
  return { kind: 'pty-data-handler-pane-owner' }
}

/** The pane that installed each handler. Non-pane holders of the slot stay unmarked. */
const paneOwnersByDataHandler = new WeakMap<PtyDataHandler, PtyDataHandlerPaneOwner>()

/**
 * Take a PTY's only data-handler slot for a pane, reporting a second pane that takes it away.
 *
 * Why not fan the data out instead: two panes on one PTY is the STA-7961 bug, not a mode to
 * support — they also both forward their fit, so the PTY grid flips between two sizes. The one
 * legitimate overlap, a remount, runs through the pending-shutdown queue, which deliberately
 * leaves the outgoing handler in the map; that case is silent.
 */
export function claimPtyDataHandlerForPane(
  ptyId: string,
  handler: PtyDataHandler,
  paneOwner: PtyDataHandlerPaneOwner
): void {
  reportOverwrittenPtyDataHandler(ptyId, handler, paneOwner)
  paneOwnersByDataHandler.set(handler, paneOwner)
}

function reportOverwrittenPtyDataHandler(
  ptyId: string,
  next: PtyDataHandler,
  paneOwner: PtyDataHandlerPaneOwner
): void {
  const previous = ptyDataHandlers.get(ptyId)
  if (!previous || previous === next || isPtyDataHandlerShutdownPending(ptyId)) {
    return
  }
  const previousOwner = paneOwnersByDataHandler.get(previous)
  // Why: the eager pre-attach buffer and a transport's shutdown handler hold the slot on the way
  // to this very pane — only a handler owned by ANOTHER pane means one PTY is mounted twice.
  if (previousOwner === undefined || previousOwner === paneOwner) {
    return
  }
  console.warn('[pty] a second pane replaced the data handler for', ptyId)
  recordRendererCrashBreadcrumb('terminal_pty_data_handler_overwritten', { ptyId })
}
