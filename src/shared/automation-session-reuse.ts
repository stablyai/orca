/** Share previous-agent reuse policy across desktop/headless hosts; callers supply pane status/liveness. */
import type { AgentType } from './agent-status-types'
import type { AutomationRun } from './automations-types'
import type { TuiAgent } from './tui-agent'

export type ReusableAutomationRun = AutomationRun & {
  terminalPaneKey: string
  terminalPtyId: string
}

/** Dispatch order is the order runs took their pane; a run never dispatched falls back to its start. */
export function automationRunRecency(run: AutomationRun): number {
  return run.dispatchedAt ?? run.startedAt ?? run.createdAt
}

export function findReusableAutomationRun<Session>(args: {
  automationId: string
  agentId: TuiAgent
  worktreeId: string
  currentRunId: string
  runs: readonly AutomationRun[]
  agentStatusForPane: (paneKey: string) => { state: string; agentType?: AgentType } | undefined
  /** The run's session while its pane still holds the run's own PTY; null otherwise. */
  liveSession: (run: ReusableAutomationRun) => Session | null
}): Session | null {
  const ownRuns = args.runs
    .filter((run) => run.id !== args.currentRunId && run.automationId === args.automationId)
    .sort((left, right) => automationRunRecency(right) - automationRunRecency(left))
  const seenPaneKeys = new Set<string>()
  for (const run of ownRuns) {
    // A pane belongs to its newest run: an older record of it is never a candidate.
    if (!run.terminalPaneKey || seenPaneKeys.has(run.terminalPaneKey)) {
      continue
    }
    seenPaneKeys.add(run.terminalPaneKey)
    if (!isReusableRun(run, args.worktreeId)) {
      continue
    }
    const status = args.agentStatusForPane(run.terminalPaneKey)
    if (!status || !isIdleAgentOf(status, args.agentId)) {
      continue
    }
    const session = args.liveSession(run)
    if (session) {
      return session
    }
  }
  return null
}

function isReusableRun(run: AutomationRun, worktreeId: string): run is ReusableAutomationRun {
  return (
    run.workspaceId === worktreeId &&
    run.status === 'completed' &&
    Boolean(run.terminalPaneKey) &&
    Boolean(run.terminalPtyId)
  )
}

function isIdleAgentOf(
  status: { state: string; agentType?: AgentType },
  agentId: TuiAgent
): boolean {
  if (status.state !== 'done') {
    return false
  }
  return !status.agentType || status.agentType === 'unknown' || status.agentType === agentId
}
