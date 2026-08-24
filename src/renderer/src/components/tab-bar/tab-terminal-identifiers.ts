import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { collectLeafIdsInOrder } from '../terminal-pane/terminal-layout-leaf-ids'

/**
 * Pane a tab-level identifier copy acts on: the focused one, so a split tab
 * copies what the user is looking at. Falls back to the first pane when the
 * focus is stale (a close/hydration race can leave it pointing at a removed
 * leaf) or absent (tab restored but never activated).
 */
export function resolveTabIdentityLeafId(
  layout: TerminalLayoutSnapshot | undefined
): string | null {
  const leafIds = collectLeafIdsInOrder(layout?.root).filter(isTerminalLeafId)
  const activeLeafId = layout?.activeLeafId
  if (
    activeLeafId &&
    isTerminalLeafId(activeLeafId) &&
    (leafIds.length === 0 || leafIds.includes(activeLeafId))
  ) {
    return activeLeafId
  }
  return leafIds[0] ?? null
}

/**
 * Provider-owned session id of the tab's agent — the id CLI `--resume` takes;
 * Orca terminal ids are not agent-session ids. Retained and sleeping records
 * are consulted too so a finished or slept agent stays copyable.
 */
export function resolveTabAgentSessionId(args: {
  tabId: string
  layout: TerminalLayoutSnapshot | undefined
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
}): string | null {
  for (const leafId of orderedTabLeafIds(args.layout)) {
    const paneKey = makePaneKey(args.tabId, leafId)
    const sessionId =
      args.agentStatusByPaneKey[paneKey]?.providerSession?.id ??
      args.retainedAgentsByPaneKey[paneKey]?.entry.providerSession?.id ??
      args.sleepingAgentSessionsByPaneKey[paneKey]?.providerSession.id
    if (sessionId) {
      return sessionId
    }
  }
  return null
}

/** Focused pane first, then the remaining panes of a split tab in layout order. */
function orderedTabLeafIds(layout: TerminalLayoutSnapshot | undefined): string[] {
  const focusedLeafId = resolveTabIdentityLeafId(layout)
  const leafIds = collectLeafIdsInOrder(layout?.root).filter(isTerminalLeafId)
  if (!focusedLeafId) {
    return leafIds
  }
  return [focusedLeafId, ...leafIds.filter((leafId) => leafId !== focusedLeafId)]
}
