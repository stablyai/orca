/** Share previous-agent reuse policy across desktop/headless hosts; callers supply pane status/liveness. */
import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import type { AutomationRun } from './automation-run'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import type { WorkspaceRunContext } from '../../work-items/task-source-context'
import { parseExecutionHostId } from '../../execution-host'
import { normalizeRuntimePathForComparison } from '../../cross-platform-path'

export type AutomationSessionTarget = Pick<WorkspaceRunContext, 'hostId' | 'repoId' | 'path'> & {
  runtimeEnvironmentId?: string | null
}

/** A run that still names its own pane and process, so its session can be looked up. */
export type AutomationRunSession = AutomationRun & {
  terminalPaneKey: string
  terminalPtyId: string
}

/** Why a live previous session cannot take this run: its agent is mid-turn, or its record is stale. */
export type AutomationSessionReuseBlockedReason = 'sessionBusy' | 'sessionNotReusable'

export type AutomationSessionReuse<Session> =
  | { outcome: 'reused'; session: Session }
  /** A previous session is still live in this workspace but cannot take the run. */
  | { outcome: 'blocked'; reason: AutomationSessionReuseBlockedReason }
  /** No previous session is live in this workspace, so a first session is not a second one. */
  | { outcome: 'none' }

export type AutomationSessionReuseArgs<Session> = {
  automationId: string
  agentId: TuiAgent
  worktreeId: string
  target: AutomationSessionTarget
  currentRunId: string
  runs: readonly AutomationRun[]
  agentStatusForPane: (paneKey: string) => { state: string; agentType?: AgentType } | undefined
  /** The run's session while its pane still holds the run's own PTY; null once the pane is gone. */
  liveSession: (run: AutomationRunSession) => Session | null
}

/** Dispatch order is the order runs took their pane; a run never dispatched falls back to its start. */
export function automationRunRecency(run: AutomationRun): number {
  return run.dispatchedAt ?? run.startedAt ?? run.createdAt
}

/**
 * Report whether the previous session can take this run, and why it cannot when one is still there.
 * A caller that must keep one session per workspace needs the reason: no live session means start
 * one, a live session that cannot take the run means skip.
 */
export function selectAutomationSessionReuse<Session>(
  args: AutomationSessionReuseArgs<Session>
): AutomationSessionReuse<Session> {
  const ownRuns = args.runs
    .filter((run) => run.id !== args.currentRunId && run.automationId === args.automationId)
    .sort((left, right) => automationRunRecency(right) - automationRunRecency(left))
  const seenPaneKeys = new Set<string>()
  let blocked: AutomationSessionReuseBlockedReason | null = null
  for (const run of ownRuns) {
    // A pane belongs to its newest run: an older record of it is never a candidate.
    if (!run.terminalPaneKey || !run.terminalPtyId || seenPaneKeys.has(run.terminalPaneKey)) {
      continue
    }
    seenPaneKeys.add(run.terminalPaneKey)
    // Another workspace's session says nothing about this workspace's one.
    if (run.workspaceId !== args.worktreeId) {
      continue
    }
    const session = args.liveSession(run)
    // A closed pane is no session at all: there is nothing to reuse and nothing to skip for.
    if (!session) {
      continue
    }
    const status = args.agentStatusForPane(run.terminalPaneKey)
    if (isReusableRun(run, args) && status && isIdleAgentOf(status, args.agentId)) {
      return { outcome: 'reused', session }
    }
    // An agent mid-turn is the actionable reason; a stale record is the fallback.
    blocked = status && status.state !== 'done' ? 'sessionBusy' : (blocked ?? 'sessionNotReusable')
  }
  return blocked ? { outcome: 'blocked', reason: blocked } : { outcome: 'none' }
}

/** The pane's newest run finished and still names this automation's target. */
function isReusableRun(
  run: AutomationRunSession,
  args: Pick<AutomationSessionReuseArgs<unknown>, 'target'>
): boolean {
  return (
    run.status === 'completed' &&
    (!run.runContext ||
      (parseExecutionHostId(run.runContext.hostId)?.id === args.target.hostId &&
        run.runContext.repoId === args.target.repoId &&
        normalizeRuntimePathForComparison(run.runContext.path) ===
          normalizeRuntimePathForComparison(args.target.path)))
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
