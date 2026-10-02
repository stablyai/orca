// Claude kills every background agent on an idle-prompt Ctrl+C (or "stop all agents") and fires
// no hook; the only record is an id-less `system`/`agents_killed` line appended to the session
// transcript (claude-idle-ctrl-c-* fixtures). The listener on the host that runs the session
// watches for it while the pane has working agent children, and retires them as SubagentStop would.
import { posix, win32 } from 'node:path'
import {
  claudeRosterHasWorkingSubagent,
  stopWorkingClaudeSubagentsStartedBy
} from '../../claude-subagent-roster'
import { createJsonlCursorAtEnd, readJsonlCursor } from '../../codex-rollout-jsonl-cursor'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { clearClaudePendingWaitForAgent } from './claude-roster-state'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'

/** The transcript path this host can watch, or undefined. */
export function claudeTranscriptWatchPath(
  transcriptPath: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform === 'win32') {
    // Why: a drive-less rooted path is a WSL guest path or a share; a sync stat there can stall
    // on 9P/SMB, and a WSL session's own guest relay watches its transcript natively.
    return win32.isAbsolute(transcriptPath) && !/^[\\/]/.test(transcriptPath)
      ? transcriptPath
      : undefined
  }
  return posix.isAbsolute(transcriptPath) ? transcriptPath : undefined
}

/** Keep the pane's watch armed only while it can matter; returns whether it is armed. */
export function syncClaudeAgentsKilledWatch(
  state: HookListenerState,
  anchor: AgentHookEventPayload
): boolean {
  const cursors = state.claudeAgentsKilledCursorByPaneKey
  const current = cursors.get(anchor.paneKey)
  const reported = anchor.providerSession?.transcriptPath
  // Why: a row with no provider session (an OSC repaint) says nothing about the transcript.
  const filePath = reported !== undefined ? claudeTranscriptWatchPath(reported) : current?.filePath
  if (
    // Why: a relayed row's session runs on another host, whose own listener watches it.
    anchor.connectionId !== null ||
    anchor.payload.agentType !== 'claude' ||
    !filePath ||
    !claudeRosterHasWorkingSubagent(state.claudeSubagentRosterByPaneKey.get(anchor.paneKey))
  ) {
    cursors.delete(anchor.paneKey)
    return false
  }
  if (current?.filePath === filePath) {
    return true
  }
  // Why: only a line appended after arming may count — a resumed session keeps its old records,
  // and a session forked into a new file copies them.
  const armed = createJsonlCursorAtEnd(filePath)
  if (!armed) {
    cursors.delete(anchor.paneKey)
    return false
  }
  cursors.set(anchor.paneKey, armed)
  return true
}

/** Reads what the transcript gained since the last tick; returns the row to publish when an
 *  `agents_killed` record retired any agent child. */
export function pollClaudeAgentsKilled(
  state: HookListenerState,
  anchor: AgentHookEventPayload
): AgentHookEventPayload | undefined {
  const { paneKey } = anchor
  if (!syncClaudeAgentsKilledWatch(state, anchor)) {
    return undefined
  }
  const cursor = state.claudeAgentsKilledCursorByPaneKey.get(paneKey)
  const records = cursor && readJsonlCursor(cursor, (line) => line.includes('"agents_killed"'))
  if (!records) {
    state.claudeAgentsKilledCursorByPaneKey.delete(paneKey)
    return undefined
  }
  let killedAt: number | undefined
  for (const record of records) {
    if (record.type !== 'system' || record.subtype !== 'agents_killed') {
      continue
    }
    const stamped = Date.parse(String(record.timestamp))
    // Why: an unreadable stamp still came after arming, so every child tracked by now was killed.
    killedAt = Math.max(killedAt ?? -Infinity, Number.isNaN(stamped) ? Infinity : stamped)
  }
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (killedAt === undefined || !roster) {
    return undefined
  }
  const mainAgent = state.claudeLeadStateByPaneKey.get(paneKey)
  const waitOwner = mainAgent?.state === 'waiting' ? mainAgent.waitingAgentId : undefined
  const retired = stopWorkingClaudeSubagentsStartedBy(roster, killedAt)
  if (retired.length === 0) {
    return undefined
  }
  clearClaudePendingWaitForAgent(state, paneKey, (agentId) => retired.includes(agentId))
  if (roster.size === 0) {
    state.claudeSubagentRosterByPaneKey.delete(paneKey)
  }
  // Why: null without a main agent record — the kill ends children, it never wakes a parent.
  const payload = buildClaudeCachedLeadStatusPayload(state, 'SubagentStop', paneKey, {})
  if (!payload) {
    return undefined
  }
  return {
    paneKey,
    source: 'claude',
    launchToken: anchor.launchToken,
    tabId: anchor.tabId,
    worktreeId: anchor.worktreeId,
    connectionId: null,
    hookEventName: 'SubagentStop',
    // Why: a child's own stop releases its held permission prompt and is re-folded under a
    // cancel verdict the desktop inferred but this host never learned of.
    toolAgentId: waitOwner && retired.includes(waitOwner) ? waitOwner : retired[0],
    claudeRunningNonAgentTask:
      state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
      state.claudeActiveSessionCronPaneKeys.has(paneKey),
    ...(anchor.providerSession ? { providerSession: anchor.providerSession } : {}),
    payload
  }
}
