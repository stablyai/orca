import type { ParsedAgentStatusPayload } from '../../../../agent-status/contracts/agent-status-types'
import type { HookListenerState } from '../../../listener-state'
import { CLAUDE_NEW_SESSION_START_SOURCES } from './claude-session-start-sources'
import { setClaudeMainAgentTurnState } from './claude-roster-state'
import { buildClaudeStatusPayload } from './claude-status-build'

export function normalizeClaudeSessionStart(
  state: HookListenerState,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  eventAgentId: string | undefined,
  leadModel: string | undefined
): ParsedAgentStatusPayload | null {
  const eventName = 'SessionStart'
  // SessionStart supplies resume identity before prompts; mark idle/sessionBoundary to avoid phantom work/completion notifications (STA-3386).
  const sessionStartSource = hookPayload['source']
  if (eventAgentId !== undefined || !CLAUDE_NEW_SESSION_START_SOURCES.has(sessionStartSource)) {
    // Only known idle sources qualify; compact restarts and child SessionStart cannot settle a live lead.
    return null
  }
  // New sessions must not inherit old child/task/cron gates.
  state.claudeSubagentRosterByPaneKey.delete(paneKey)
  state.claudeRunningNonAgentTasksByPaneKey.delete(paneKey)
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  state.claudeLaunchedBackgroundTasksByPaneKey.delete(paneKey)
  // New sessions start a new main-agent clock.
  setClaudeMainAgentTurnState(state, paneKey, {
    state: 'done',
    stateStartedAt: Date.now(),
    model: leadModel
  })
  return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
    stateName: 'done',
    updateToolSnapshot: true,
    sessionBoundary: true
  })
}
