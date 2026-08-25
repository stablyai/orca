import {
  normalizeAgentStatusPayload,
  type AgentStatusState,
  type AgentWorkingMode,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { claudeRosterToSnapshots } from '../../claude-subagent-roster'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import type { HookListenerState } from '../listener-state'

export function buildClaudeStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  options: {
    stateName: AgentStatusState
    workingMode?: AgentWorkingMode
    updateToolSnapshot: boolean
    interrupted?: boolean
    sessionBoundary?: boolean
    turnCompletedAt?: number
  }
): ParsedAgentStatusPayload | null {
  // Why: child-driven refreshes are roster bookkeeping, not lead tool activity; read the cached snapshot without merging so they can't clear a live AskUserQuestion card or clobber the tool preview.
  const snapshot = options.updateToolSnapshot
    ? resolveToolState(state, paneKey, extractToolFields('claude', eventName, hookPayload), {
        resetOnNewTurn: isNewTurnEvent('claude', eventName)
      })
    : (state.lastToolByPaneKey.get(paneKey) ?? {})

  // Why: validate directly — the JSON stringify/parse round trip other normalizers use is pure overhead on this hot per-hook path.
  // The normalizer clamps `interrupted` to done payloads, so a gated 'working' emit drops it; claudeLeadStateByPaneKey preserves it for the eventual done.
  return normalizeAgentStatusPayload({
    state: options.stateName,
    workingMode: options.workingMode,
    // Why: only lead-origin events may reset the prompt cache; a child-driven refresh must not blank the lead's prompt label.
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: options.updateToolSnapshot && isNewTurnEvent('claude', eventName)
    }),
    agentType: 'claude',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    interrupted: options.interrupted,
    sessionBoundary: options.sessionBoundary,
    turnCompletedAt: options.turnCompletedAt,
    subagents: claudeRosterToSnapshots(state.claudeSubagentRosterByPaneKey.get(paneKey))
  })
}
