/**
 * Which previous run's agent a `reuseSession` automation sends its next prompt to. One rule for
 * the desktop and a headless host; each supplies its own read of the pane's status and liveness.
 */
import type { AgentType } from './agent-status-types'
import type { AutomationRun } from './automations-types'
import type { TuiAgent } from './tui-agent'

export type ReusableTerminalAutomationRun = AutomationRun & {
  terminalPaneKey: string
  terminalPtyId: string
}

export type ReusableStructuredAutomationRun = AutomationRun & {
  sessionKind: 'structured'
  chatSessionId: string
}

export type ReusableAutomationRun = ReusableTerminalAutomationRun | ReusableStructuredAutomationRun

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
  liveSession: (run: ReusableTerminalAutomationRun) => Session | null
  /** Optional: structured chat status and liveness for a run with `sessionKind: 'structured'`. */
  structuredStatusForSession?: (
    chatSessionId: string,
    run: ReusableStructuredAutomationRun
  ) => { state: string; agentType?: AgentType } | undefined
  liveStructuredSession?: (run: ReusableStructuredAutomationRun) => Session | null
}): Session | null {
  const ownRuns = args.runs
    .filter((run) => run.id !== args.currentRunId && run.automationId === args.automationId)
    .sort((left, right) => automationRunRecency(right) - automationRunRecency(left))
  const seenPaneKeys = new Set<string>()
  const seenChatSessionIds = new Set<string>()
  for (const run of ownRuns) {
    const session = isStructuredRunCandidate(run)
      ? tryReuseStructuredRun(run, seenChatSessionIds, args)
      : tryReuseTerminalRun(run, seenPaneKeys, args)
    if (session) {
      return session
    }
  }
  return null
}

function tryReuseStructuredRun<Session>(
  run: AutomationRun & { sessionKind: 'structured'; chatSessionId: string },
  seenChatSessionIds: Set<string>,
  args: Parameters<typeof findReusableAutomationRun<Session>>[0]
): Session | null {
  if (seenChatSessionIds.has(run.chatSessionId)) {
    return null
  }
  seenChatSessionIds.add(run.chatSessionId)
  if (!isReusableStructuredRun(run, args.worktreeId)) {
    return null
  }
  const status = args.structuredStatusForSession?.(run.chatSessionId, run)
  if (!status || !isIdleAgentOf(status, args.agentId)) {
    return null
  }
  return args.liveStructuredSession?.(run) ?? null
}

function tryReuseTerminalRun<Session>(
  run: AutomationRun,
  seenPaneKeys: Set<string>,
  args: Parameters<typeof findReusableAutomationRun<Session>>[0]
): Session | null {
  if (!run.terminalPaneKey || seenPaneKeys.has(run.terminalPaneKey)) {
    return null
  }
  seenPaneKeys.add(run.terminalPaneKey)
  if (!isReusableTerminalRun(run, args.worktreeId)) {
    return null
  }
  const status = args.agentStatusForPane(run.terminalPaneKey)
  if (!status || !isIdleAgentOf(status, args.agentId)) {
    return null
  }
  return args.liveSession(run)
}

function isStructuredRunCandidate(
  run: AutomationRun
): run is AutomationRun & { sessionKind: 'structured'; chatSessionId: string } {
  return run.sessionKind === 'structured' && Boolean(run.chatSessionId)
}

function isReusableStructuredRun(
  run: AutomationRun,
  worktreeId: string
): run is ReusableStructuredAutomationRun {
  return (
    run.workspaceId === worktreeId &&
    run.status === 'completed' &&
    run.sessionKind === 'structured' &&
    Boolean(run.chatSessionId)
  )
}

function isReusableTerminalRun(
  run: AutomationRun,
  worktreeId: string
): run is ReusableTerminalAutomationRun {
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
