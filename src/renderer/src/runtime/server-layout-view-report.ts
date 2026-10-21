// Tells a paired server which group this window shows in each workspace its frames draw
// (`layout.reportView`), so a CLI or phone file opened on the server lands where the user looks.
// Group ids are the server's own: frames draw its groups under their ids. Fire-and-forget.

import { errorMessage } from '../../../shared/error-message'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { callRuntimeRpc } from './runtime-rpc-client'
import { changedActiveGroups } from './sync-runtime-graph/active-group-publication'

export type ServerViewReport = {
  /** Sends the frame-drawn workspaces whose group changed since the last send, if any did.
   *  `fromFrames`: the server's own frames moved it, not the user, so it goes as a refresh. */
  update: (
    activeGroupIdByWorktree: Readonly<Record<string, string>>,
    drawn: ReadonlySet<string>,
    fromFrames?: boolean
  ) => void
  /** Forgets what was sent: a new stream may come with a connection the server knows nothing of.
   *  The next report of each workspace is a refresh, which never outranks another client's. A
   *  server that lacked the method stays skipped: it is the same server for this stream's life. */
  reset: () => void
}

function only(
  groups: Readonly<Record<string, string>>,
  drawn: ReadonlySet<string>
): Record<string, string> {
  return Object.fromEntries(Object.entries(groups).filter(([key]) => drawn.has(key)))
}

function partition(
  groups: Record<string, string | null>,
  first: (key: string) => boolean
): [Record<string, string | null>, Record<string, string | null>] {
  const entries = Object.entries(groups)
  return [
    Object.fromEntries(entries.filter(([key]) => first(key))),
    Object.fromEntries(entries.filter(([key]) => !first(key)))
  ]
}

export function createServerViewReport(environmentId: string): ServerViewReport {
  let sent: Record<string, string> = {}
  /** Workspaces reported since the last reset: a first report re-establishes, a later one is a change. */
  const reported = new Set<string>()
  // Store slices are replaced, never edited: unchanged inputs have nothing new to send.
  let seen: [Readonly<Record<string, string>>, ReadonlySet<string>] | null = null
  /** A switch-on server from before the method: it advertises layout intents without it. */
  let unsupported = false
  const send = (activeGroupByWorkspace: Record<string, string | null>, refresh: boolean): void => {
    if (unsupported || Object.keys(activeGroupByWorkspace).length === 0) {
      return
    }
    callRuntimeRpc({ kind: 'environment', environmentId }, 'layout.reportView', {
      activeGroupByWorkspace,
      ...(refresh ? { refresh: true } : {})
    }).catch((error: unknown) => {
      if (unsupported) {
        return
      }
      if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
        unsupported = true
        console.warn(
          '[layout-owner] this server takes no view reports; files open in its saved view'
        )
        return
      }
      // Not resent: the next change or stream reports again, and the server keeps its saved view.
      console.warn('[layout-owner] a server did not take the view report:', errorMessage(error))
    })
  }
  return {
    update: (activeGroupIdByWorktree, drawn, fromFrames = false) => {
      if (seen?.[0] === activeGroupIdByWorktree && seen[1] === drawn) {
        return
      }
      seen = [activeGroupIdByWorktree, drawn]
      const current = only(activeGroupIdByWorktree, drawn)
      // A workspace that left the frames is not reported as showing none: its server keeps the last.
      const changed = changedActiveGroups(current, only(sent, drawn))
      sent = current
      if (!changed) {
        return
      }
      const [refreshed, live] = partition(changed, (key) => fromFrames || !reported.has(key))
      for (const key of Object.keys(changed)) {
        reported.add(key)
      }
      send(refreshed, true)
      send(live, false)
    },
    reset: () => {
      sent = {}
      seen = null
      reported.clear()
    }
  }
}

/** Calls back each time the shared control connection to `environmentId` comes up on a new socket:
 *  the server dropped the reports of the old one, while the layout stream may have stayed up. */
export function onServerControlConnected(environmentId: string, connected: () => void): () => void {
  let socket: string | null = null
  return (
    window.api?.runtimeEnvironments?.onSharedControlDiagnostics?.((event) => {
      if (event.environmentId !== environmentId || event.diagnostics.state !== 'ready') {
        return
      }
      const next = `${event.transportGeneration}:${event.diagnostics.lastConnectedAt}`
      if (next !== socket) {
        socket = next
        connected()
      }
    }) ?? (() => {})
  )
}
