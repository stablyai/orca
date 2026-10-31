/** Share previous-agent reuse policy across desktop/headless hosts; callers supply pane status/liveness. */
import type { AgentType } from './agent-status-types'
import type { AutomationRun } from './automations-types'
import type { TuiAgent } from './tui-agent'

export type ReusableAutomationRun = AutomationRun & {
  terminalPaneKey: string
  terminalPtyId: string
}

export type LiveAutomationSession<Session> = {
  run: ReusableAutomationRun
  session: Session
}

type LiveRunArgs<Session> = {
  automationId: string
  worktreeId: string
  currentRunId: string
  runs: readonly AutomationRun[]
  /** The run's session while its pane still holds the run's own PTY; null otherwise. */
  liveSession: (run: ReusableAutomationRun) => Session | null
}

/** Dispatch order is the order runs took their pane; a run never dispatched falls back to its start. */
export function automationRunRecency(run: AutomationRun): number {
  return run.dispatchedAt ?? run.startedAt ?? run.createdAt
}

export function isAutomationReuseAgent(
  status: { agentType?: AgentType },
  agentId: TuiAgent
): boolean {
  return !status.agentType || status.agentType === 'unknown' || status.agentType === agentId
}

/** Idle means the agent finished its turn and can take another prompt; a session boundary is not a turn. */
export function isIdleAutomationReuseStatus(
  status: { state: string; agentType?: AgentType; sessionBoundary?: boolean },
  agentId: TuiAgent
): boolean {
  return (
    status.state === 'done' && !status.sessionBoundary && isAutomationReuseAgent(status, agentId)
  )
}

export function findReusableAutomationRun<Session>(
  args: LiveRunArgs<Session> & {
    agentId: TuiAgent
    agentStatusForPane: (paneKey: string) => { state: string; agentType?: AgentType } | undefined
  }
): Session | null {
  // The newest live pane is the automation's session; older panes are leftovers it must not fall back to.
  const newest = findLiveAutomationRun(args)
  if (!newest || newest.run.status !== 'completed') {
    return null
  }
  const status = args.agentStatusForPane(newest.run.terminalPaneKey)
  return status && isIdleAutomationReuseStatus(status, args.agentId) ? newest.session : null
}

/** The newest session this automation still holds, whatever its agent is doing; callers may wait for it. */
export function findLiveAutomationRun<Session>(
  args: LiveRunArgs<Session>
): LiveAutomationSession<Session> | null {
  for (const candidate of liveRuns(args)) {
    return candidate
  }
  return null
}

function* liveRuns<Session>(args: LiveRunArgs<Session>): Generator<LiveAutomationSession<Session>> {
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
    const session = args.liveSession(run)
    if (session) {
      yield { run, session }
    }
  }
}

function isReusableRun(run: AutomationRun, worktreeId: string): run is ReusableAutomationRun {
  return (
    run.workspaceId === worktreeId &&
    (run.status === 'completed' || run.status === 'dispatched') &&
    Boolean(run.terminalPaneKey) &&
    Boolean(run.terminalPtyId)
  )
}
