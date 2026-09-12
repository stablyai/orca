import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { normalizeOptionalField } from '../../agent-status-field-normalization'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { extractAgentProviderSession } from '../../agent-session-resume'
import {
  codexRosterEffectiveState,
  codexRosterToSnapshots,
  finishCodexSubagent,
  upsertCodexSubagent
} from '../../codex-subagent-roster'
import { reconcileCodexSubagentTranscript } from '../../codex-subagent-transcript'
import { readFirstString } from '../interactive-tool'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import {
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  hasCodexTranscriptSubagents
} from './codex-state'

export function buildCodexStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  options: { stateName: 'working' | 'waiting' | 'done'; updateLead: boolean }
): ParsedAgentStatusPayload | null {
  const snapshot = options.updateLead
    ? resolveToolState(state, paneKey, extractToolFields('codex', eventName, hookPayload), {
        resetOnNewTurn: isNewTurnEvent('codex', eventName)
      })
    : (state.lastToolByPaneKey.get(paneKey) ?? {})
  const lead = state.codexLeadStateByPaneKey.get(paneKey)

  return normalizeAgentStatusPayload({
    state: options.stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: options.updateLead && isNewTurnEvent('codex', eventName)
    }),
    agentType: 'codex',
    model: lead?.model,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    subagents: codexRosterToSnapshots(state.codexSubagentRosterByPaneKey.get(paneKey))
  })
}

export function buildCodexChildDrivenStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const leadState = state.codexLeadStateByPaneKey.get(paneKey)?.state ?? 'working'
  const stateName = codexRosterEffectiveState(
    state.codexSubagentRosterByPaneKey.get(paneKey),
    leadState
  )
  return buildCodexStatusPayload(state, eventName, '', paneKey, hookPayload, {
    stateName,
    updateLead: false
  })
}

export function normalizeCodexSubagentLifecycleEvent(
  state: HookListenerState,
  eventName: 'SubagentStart' | 'SubagentStop',
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const agentId = readString(hookPayload, 'agent_id')
  if (!agentId) {
    return null
  }
  const roster = getOrCreateCodexSubagentRoster(state, paneKey)
  const agentType = readString(hookPayload, 'agent_type')
  if (eventName === 'SubagentStart') {
    upsertCodexSubagent(
      roster,
      agentId,
      {
        agentType,
        model: readString(hookPayload, 'model'),
        state: 'working'
      },
      Date.now()
    )
    // Why: child start has no tool_name; show the agent type in the status tool row.
    if (agentType) {
      resolveToolState(
        state,
        paneKey,
        { toolName: agentType, hasToolUpdate: true },
        {
          resetOnNewTurn: false
        }
      )
    }
  } else {
    finishCodexSubagent(roster, agentId)
    const message = readString(hookPayload, 'last_assistant_message')
    if (message) {
      resolveToolState(state, paneKey, { lastAssistantMessage: message }, { resetOnNewTurn: false })
    }
  }
  return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
}

export function normalizeCodexEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    return normalizeCodexSubagentLifecycleEvent(state, eventName, paneKey, hookPayload)
  }

  // Why: child hooks share the parent paneKey and carry their own session_id.
  // Root SessionStart reset must not run for them — it would drop parent
  // status/roster and store the child session as the resume id.
  const childAgentId = readString(hookPayload, 'agent_id')
  if (childAgentId && eventName === 'SessionStart') {
    return null
  }

  if (eventName === 'SessionStart') {
    // Why: Codex fires SessionStart when opening or resuming an idle TUI, before
    // a user prompt exists; reset stale turn/session cache without emitting state.
    // Cache provider session identity for the next real status event.
    clearPaneTurnCacheState(state, paneKey)
    state.codexSubagentRosterByPaneKey.delete(paneKey)
    state.codexSubagentTranscriptByPaneKey.delete(paneKey)
    state.codexLeadStateByPaneKey.delete(paneKey)
    // Why: retain session id from SessionStart for the subsequent working event.
    const extracted = extractAgentProviderSession('codex', hookPayload)
    if (extracted) {
      state.lastProviderSessionByPaneKey.set(paneKey, extracted)
    } else {
      state.lastProviderSessionByPaneKey.delete(paneKey)
    }
    if (state.lastStatusByPaneKey.get(paneKey)?.payload.agentType === 'codex') {
      state.lastStatusByPaneKey.delete(paneKey)
    }
    return null
  }

  // Why: Codex's request_user_input (0.145+) is auto-allowed, so it fires PreToolUse while
  // blocked on a human answer; map to waiting like generic ask-user-question tools.
  const isUserInputPreTool =
    eventName === 'PreToolUse' &&
    isAskUserQuestionTool(readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name'))
  let stateName: 'working' | 'waiting' | 'done' | null =
    eventName === 'UserPromptSubmit' ||
    (eventName === 'PreToolUse' && !isUserInputPreTool) ||
    eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'PermissionRequest' || isUserInputPreTool
        ? 'waiting'
        : eventName === 'Stop'
          ? 'done'
          : null
  if (!stateName) {
    return null
  }

  if (
    stateName === 'working' &&
    eventName !== 'UserPromptSubmit' &&
    codexPayloadIsInterrupted(hookPayload)
  ) {
    stateName = 'done'
  }

  const agentId = readString(hookPayload, 'agent_id')
  if (agentId) {
    upsertCodexSubagent(
      getOrCreateCodexSubagentRoster(state, paneKey),
      agentId,
      {
        agentType: readString(hookPayload, 'agent_type'),
        model: readString(hookPayload, 'model'),
        state: stateName === 'waiting' ? 'waiting' : 'working'
      },
      Date.now()
    )
    return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload)
  }

  const transcriptPath = readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
  if (transcriptPath) {
    reconcileCodexSubagentTranscript(
      getOrCreateCodexSubagentTranscriptState(state, paneKey),
      getOrCreateCodexSubagentRoster(state, paneKey),
      transcriptPath
    )
  }
  if (eventName === 'Stop' && !hasCodexTranscriptSubagents(state, paneKey)) {
    // Why: Codex CLI 0.144 can omit child Stop hooks; later child activity safely recreates any agent still running.
    state.codexSubagentRosterByPaneKey.delete(paneKey)
  }
  const previousLead = state.codexLeadStateByPaneKey.get(paneKey)
  state.codexLeadStateByPaneKey.set(paneKey, {
    state: stateName,
    model:
      normalizeOptionalField(hookPayload['model'], AGENT_MODEL_MAX_LENGTH) ?? previousLead?.model
  })
  const effectiveState = codexRosterEffectiveState(
    state.codexSubagentRosterByPaneKey.get(paneKey),
    stateName
  )
  const payload = buildCodexStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
    stateName: effectiveState,
    updateLead: true
  })
  if (!payload) {
    return null
  }
  const interrupted =
    stateName === 'done' && codexPayloadIsInterrupted(hookPayload) ? true : undefined
  return interrupted ? { ...payload, interrupted } : payload
}

function codexPayloadIsInterrupted(hookPayload: Record<string, unknown>): boolean {
  if (hookPayload['is_interrupt'] === true || hookPayload['interrupted'] === true) {
    return true
  }
  const stopReason = readFirstString(hookPayload, ['stop_reason', 'stopReason'])?.toLowerCase()
  return (
    stopReason?.includes('interrupt') === true ||
    stopReason?.includes('abort') === true ||
    stopReason?.includes('cancel') === true
  )
}
