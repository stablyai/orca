import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentRowState } from '../../../../shared/agent-row-decay-state'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  agentChildRowContextForParent,
  type AgentChildRowModel
} from '../../../../shared/agent-child-row-model'
import {
  agentChildRunStateFor,
  type AgentChildDisplayState
} from '../../../../shared/agent-status-child-work-display'
import { buildRunningAgentChildRowModels } from '../../../../shared/running-agent-child-rows'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** NUL prevents collision with real pane keys; synthetic keys are never parsed for activation, which uses the parent pane. */
function subagentRowKey(parentPaneKey: string, subagentId: string): string {
  return `${parentPaneKey}\u0000subagent:${subagentId}`
}

function agentRowStateFor(displayState: AgentChildDisplayState): AgentRowState {
  const runState = agentChildRunStateFor(displayState)
  // A CLI row carries monitoring as `working` plus its `workingMode`.
  return runState === 'monitoring' ? 'working' : runState
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

/** Child rows reuse and activate the parent pane; prefer host child views and retain legacy snapshot support. */
export function buildSubagentChildRows(args: {
  parentEntry: AgentStatusEntry
  tab: TerminalTab
  /** A stale parent hook stream makes active child evidence unverifiable too. */
  parentIsFresh: boolean
}): DashboardAgentRow[] {
  const { parentEntry } = args
  const context = agentChildRowContextForParent(parentEntry, args.parentIsFresh)
  return buildRunningAgentChildRowModels(parentEntry, context).map((row) =>
    childDashboardRow(row, parentEntry, args.tab)
  )
}
