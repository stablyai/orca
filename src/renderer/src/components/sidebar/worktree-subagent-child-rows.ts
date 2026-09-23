import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentRowState } from '@/lib/agent-row-decay-state'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  agentChildRowContextForParent,
  buildAgentChildRowModels,
  buildLegacyAgentChildRowModels,
  flattenAgentChildRowModels,
  type AgentChildRowModel
} from '../../../../shared/agent-child-row-model'
import type { AgentChildDisplayState } from '../../../../shared/agent-status-child-work-display'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** Row-identity key for an in-process subagent child row. The NUL separator
 *  cannot appear in real pane keys, so synthetic keys can never collide with
 *  one. Never parsed back — activation goes through `activationPaneKey` /
 *  `orchestration.parentPaneKey` instead. */
function subagentRowKey(parentPaneKey: string, subagentId: string): string {
  return `${parentPaneKey}\u0000subagent:${subagentId}`
}

/** The lifecycle word every reader of a CLI row already understands; the row's own dot says more. */
function agentRowStateFor(displayState: AgentChildDisplayState): AgentRowState {
  switch (displayState) {
    case 'working':
    case 'monitoring':
      return 'working'
    case 'failed':
      return 'blocked'
    case 'interrupted':
      return 'idle'
    case 'waiting':
    case 'blocked':
    case 'done':
    case 'idle':
    case 'unverifiable':
      return displayState
  }
}

function childDashboardRow(
  row: AgentChildRowModel,
  parentEntry: AgentStatusEntry,
  tab: TerminalTab
): DashboardAgentRow {
  const state = agentRowStateFor(row.displayState)
  const startedAt = row.firstObservedAt > 0 ? row.firstObservedAt : parentEntry.stateStartedAt
  const paneKey = subagentRowKey(parentEntry.paneKey, row.id)
  const detail = row.detail
  // The same fields a CLI agent row carries, so every reader of a CLI row reads a child the same way.
  const entry: AgentStatusEntry = {
    state: state === 'idle' || state === 'unverifiable' ? 'done' : state,
    ...(row.displayState === 'monitoring' ? { workingMode: 'monitoring' as const } : {}),
    prompt: row.name,
    // The parent's delivery clock; the child's own evidence clock rides `evidenceObservedAt`.
    updatedAt: parentEntry.updatedAt,
    ...(row.observedAt !== undefined ? { evidenceObservedAt: row.observedAt } : {}),
    stateStartedAt: startedAt,
    agentType: row.agentType,
    model: row.model,
    ...(detail?.kind === 'operation'
      ? {
          toolName: detail.toolName,
          ...(detail.input !== undefined ? { toolInput: detail.input } : {})
        }
      : {}),
    ...(detail?.kind === 'message' ? { lastAssistantMessage: detail.text } : {}),
    paneKey,
    worktreeId: parentEntry.worktreeId,
    tabId: parentEntry.tabId,
    stateHistory: [],
    orchestration: {
      taskId: `subagent:${row.id}`,
      dispatchId: `subagent:${row.id}`,
      displayName: row.name || undefined,
      parentPaneKey: parentEntry.paneKey
    }
  }
  return {
    paneKey,
    entry,
    tab,
    agentType: row.agentType ?? 'unknown',
    rowSource: 'subagent',
    state,
    activationPaneKey: parentEntry.paneKey,
    startedAt,
    childRow: row
  }
}

/**
 * Derive indented child rows for the subagents/teammates a pane's agent has
 * spawned. These children have no PTY or tab of their own: the rows reuse the
 * parent's tab, activate the parent's pane, and link into the existing lineage
 * tree through `orchestration.parentPaneKey`. The host's child views win; a host
 * that sends only the legacy `subagents` snapshot (an old host, any CLI pane)
 * is read as before.
 */
export function buildSubagentChildRows(args: {
  parentEntry: AgentStatusEntry
  tab: TerminalTab
  /** Freshness of the parent's hook stream. A stale parent means active child
   *  states are equally unverifiable. */
  parentIsFresh: boolean
}): DashboardAgentRow[] {
  const { parentEntry } = args
  const context = agentChildRowContextForParent(parentEntry, args.parentIsFresh)
  const rows =
    parentEntry.children !== undefined
      ? buildAgentChildRowModels(parentEntry.children, context)
      : buildLegacyAgentChildRowModels(parentEntry.subagents ?? [], context)
  // Shells and monitors show through their owner's dot; the sidebar lists agents.
  return flattenAgentChildRowModels(rows)
    .filter((row) => row.kind === 'agent')
    .map((row) => childDashboardRow(row, parentEntry, args.tab))
}
