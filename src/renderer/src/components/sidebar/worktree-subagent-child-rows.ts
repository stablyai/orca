import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** Row-identity key for an in-process subagent child row. The NUL separator
 *  cannot appear in real pane keys, so synthetic keys can never collide with
 *  one. Never parsed back — activation goes through `activationPaneKey` /
 *  `orchestration.parentPaneKey` instead. */
function subagentRowKey(parentPaneKey: string, subagentId: string): string {
  return `${parentPaneKey}\u0000subagent:${subagentId}`
}

/**
 * Derive indented child rows for the live in-process subagents/teammates a
 * pane's agent has spawned (entry.subagents, reported via agent hooks). These
 * children have no PTY or tab of their own: the rows reuse the parent's tab,
 * activate the parent's pane, and link into the existing lineage tree through
 * `orchestration.parentPaneKey`.
 */
export function buildSubagentChildRows(args: {
  parentEntry: AgentStatusEntry
  tab: TerminalTab
  /** Freshness of the parent's hook stream. A stale parent means active child
   *  states are equally stale, so they decay to idle together. */
  parentIsFresh: boolean
}): DashboardAgentRow[] {
  const subagents = args.parentEntry.subagents
  if (!subagents || subagents.length === 0) {
    return []
  }
  return subagents.map((subagent) => {
    const observation = args.parentEntry.subagentObservation
    const fresh = observation === 'live' || (observation === undefined && args.parentIsFresh)
    const activeState =
      fresh && subagent.state !== 'idle' && subagent.state !== 'unverifiable'
        ? subagent.state
        : undefined
    // K1: this used to fall through to 'idle' whenever `subagent.state` was already 'idle' or the
    // observation was merely absent — a stale roster (or no roster confirmation on a stale
    // parent) is exactly as unknown as an explicit 'unverifiable' one, and must read the same way
    // rather than defaulting to "nothing is known, so call it idle".
    const state =
      subagent.state === 'unverifiable' || !fresh ? 'unverifiable' : (activeState ?? 'idle')
    const startedAt = subagent.startedAt > 0 ? subagent.startedAt : args.parentEntry.stateStartedAt
    const paneKey = subagentRowKey(args.parentEntry.paneKey, subagent.id)
    const entry: AgentStatusEntry = {
      // Why 'done' and not 'unverifiable' here: AgentStatusEntry.state is typed AgentStatusState,
      // which has no 'unverifiable' member — the row-level `state` above (AgentRowState) is the
      // field that actually carries that verdict to the sidebar; this one only ever needs to
      // express real active work.
      state: activeState ?? 'done',
      prompt: subagent.description ?? subagent.agentType ?? '',
      updatedAt: args.parentEntry.updatedAt,
      stateStartedAt: startedAt,
      agentType: subagent.agentType,
      model: subagent.model,
      paneKey,
      worktreeId: args.parentEntry.worktreeId,
      tabId: args.parentEntry.tabId,
      stateHistory: [],
      // Why: this row is an in-process child, not a Task/Dispatch — never
      // fabricate orchestration.taskId/dispatchId for it (issue #8251).
      subagent: { id: subagent.id, parentPaneKey: args.parentEntry.paneKey }
    }
    return {
      paneKey,
      entry,
      tab: args.tab,
      agentType: subagent.agentType ?? 'unknown',
      rowSource: 'subagent' as const,
      state,
      activationPaneKey: args.parentEntry.paneKey,
      startedAt
    }
  })
}
