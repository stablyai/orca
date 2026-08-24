import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** Row-identity key for an in-process subagent child row. The NUL separator
 *  cannot appear in real pane keys, so synthetic keys can never collide with
 *  one. Never parsed back — activation goes through `activationPaneKey` /
 *  `orchestration.parentPaneKey` instead. */
function subagentRowKey(parentPaneKey: string, subagentId: string): string {
  return `${parentPaneKey}\u0000subagent:${subagentId}`
}

function resolveSubagentProvider(parentEntry: AgentStatusEntry, tab: TerminalTab): AgentType {
  const entryAgentType = resolveCompatibleAgentTypeForOwner(parentEntry.agentType, tab.launchAgent)
  return entryAgentType && entryAgentType !== 'unknown'
    ? entryAgentType
    : (tab.launchAgent ?? entryAgentType ?? 'unknown')
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
  const provider = resolveSubagentProvider(args.parentEntry, args.tab)
  return subagents.map((subagent) => {
    const activeState = args.parentIsFresh && subagent.state !== 'idle' ? subagent.state : undefined
    const state = activeState ?? 'idle'
    const startedAt = subagent.startedAt > 0 ? subagent.startedAt : args.parentEntry.stateStartedAt
    const paneKey = subagentRowKey(args.parentEntry.paneKey, subagent.id)
    const entry: AgentStatusEntry = {
      state: activeState ?? 'done',
      prompt: subagent.description ?? subagent.agentType ?? '',
      updatedAt: args.parentEntry.updatedAt,
      stateStartedAt: startedAt,
      agentType: subagent.agentType,
      model: subagent.model,
      paneKey,
      worktreeId: args.parentEntry.worktreeId,
      connectionId: args.parentEntry.connectionId,
      tabId: args.parentEntry.tabId,
      stateHistory: [],
      orchestration: {
        taskId: `subagent:${subagent.id}`,
        dispatchId: `subagent:${subagent.id}`,
        displayName: subagent.description,
        parentPaneKey: args.parentEntry.paneKey
      }
    }
    return {
      paneKey,
      entry,
      tab: args.tab,
      agentType: subagent.agentType ?? 'unknown',
      rowSource: 'subagent' as const,
      state,
      activationPaneKey: args.parentEntry.paneKey,
      subagentSession: {
        id: subagent.id,
        provider,
        parentPaneKey: args.parentEntry.paneKey
      },
      startedAt
    }
  })
}
