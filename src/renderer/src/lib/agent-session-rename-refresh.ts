import { isAgentRenamedTerminalTitle } from '../../../shared/agent-session-rename-title'

// Why: a live OSC title change is the only immediate signal that a deliberate
// `/rename` may have happened — the agent fires no hook for it. One refresh per
// tab is in flight at a time so a burst of title frames cannot fan out into
// concurrent transcript scans; the newest frame of the burst is queued rather
// than dropped, or the tab would keep a rename verdict for a title it no longer
// shows until some later title change happens to arrive.
const inFlightTabIds = new Set<string>()
const queuedByTabId = new Map<string, AgentRenamedTabTitleRefreshArgs>()

export type AgentRenamedTabTitleRefreshArgs = {
  tabId: string
  /** Live title the refresh is explaining; a rename must still match it. */
  liveTitle: string
  /** Transcript per pane of the tab — a split tab can run several sessions. */
  transcriptPaths: readonly string[]
  connectionId: string | null
  apply: (agentRenamedTitle: string | null) => void
}

export function scheduleAgentRenamedTabTitleRefresh(args: AgentRenamedTabTitleRefreshArgs): void {
  // Why: the store also runs in the headless/web harness, where `window` and the
  // desktop preload bridge may be absent.
  const getRenamedTitle =
    typeof window === 'undefined' ? undefined : window.api?.agentSession?.getRenamedTitle
  if (!getRenamedTitle || args.transcriptPaths.length === 0) {
    return
  }
  if (inFlightTabIds.has(args.tabId)) {
    queuedByTabId.set(args.tabId, args)
    return
  }
  inFlightTabIds.add(args.tabId)
  void (async () => {
    try {
      for (const transcriptPath of args.transcriptPaths) {
        const renamedTitle = await getRenamedTitle({
          transcriptPath,
          ...(args.connectionId ? { connectionId: args.connectionId } : {})
        })
        if (isAgentRenamedTerminalTitle(args.liveTitle, renamedTitle)) {
          args.apply(renamedTitle)
          return
        }
      }
      args.apply(null)
    } catch {
      // Best-effort: an unreadable transcript leaves the generated title in place.
    } finally {
      inFlightTabIds.delete(args.tabId)
      const queued = queuedByTabId.get(args.tabId)
      if (queued) {
        queuedByTabId.delete(args.tabId)
        scheduleAgentRenamedTabTitleRefresh(queued)
      }
    }
  })()
}
