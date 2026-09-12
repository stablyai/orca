import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { AgentStatusMetadata } from '@/store/slices/agent-status'
import type { AppState } from '../../store/types'

/**
 * Routing for a status row the host published for a structured (native chat) session.
 *
 * A structured session has no PTY and no terminal tab, so the terminal-tab routing index the PTY
 * path uses resolves nothing for its pane key. Its surface is an `agent-session` tab in
 * `unifiedTabsByWorktree`, and that tab is REQUIRED here — deliberately narrower than the
 * admission rule `worktree ps` uses, which lists a session the host holds whether or not any
 * surface is open:
 *
 * - it is what the renderer already showed. The bridge this replaces only ever wrote a row for a
 *   mounted `agent-session` tab, so requiring one keeps sidebar visibility unchanged;
 * - a terminal tab in chat view mode is backed by a structured session too
 *   (`TerminalPaneNativeChatPortal`), and it already has its own pane's row. Admitting the host's
 *   row for that session as well would put two rows in the sidebar for one tab.
 */
export function resolveStructuredAgentSessionRowRouting(
  state: Pick<AppState, 'unifiedTabsByWorktree'>,
  ownerTabId: string | undefined
): { worktreeId: string; title: string | undefined } | undefined {
  if (!ownerTabId) {
    return undefined
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (
        tab.contentType === 'agent-session' &&
        // A mirrored session whose derived id was occupied is re-hosted at `${baseId}:history-N`,
        // so match the id derived from the session as well as the surface's own.
        (tab.id === ownerTabId || structuredAgentSessionTabId(tab.entityId) === ownerTabId)
      ) {
        // The chat's own name, read from this renderer's tab state — the row carries no title,
        // and the sidebar's synthesized tab for a paneless row would otherwise read 'Agent'.
        return {
          worktreeId,
          title: tab.customLabel?.trim() || tab.label?.trim() || undefined
        }
      }
    }
  }
  return undefined
}

/** Row facets that follow from the host owning this session, not from anything a pane reported. */
export function structuredAgentSessionRowMetadata(
  data: Pick<AgentStatusIpcPayload, 'structuredHost'>
): AgentStatusMetadata | undefined {
  if (!data.structuredHost) {
    return undefined
  }
  return {
    // No terminal to resume into: the session restores itself from its journal, and a resume
    // record minted for it would offer to relaunch a native chat as a TUI.
    terminalResumeEligible: false,
    // The freshness bypass in agent-status-freshness.ts. Without it an owned session that works
    // for over half an hour decays to stale while the host is still running it.
    ...(data.structuredHost === 'owned' ? { structuredHostOwned: true as const } : {})
  }
}
