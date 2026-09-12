import { normalizeAgentStatusPayload } from './agent-status-types'
import type { AgentHookSource } from './agent-hook-relay'
import { extractAgentProviderSession } from './agent-session-resume'
import {
  canAcceptClaudeCompactCompletion,
  isClaudeCompactCompletionConsumed,
  markClaudeCompactCompletionConsumed
} from './claude-compact-completion'
import { parseHookEnvelope } from './agent-hook-listener/hook-envelope'
import { readFirstString } from './agent-hook-listener/interactive-tool'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { normalizeClaudePromptId } from './agent-hook-listener/listener-limits'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import { extractPromptText } from './agent-hook-listener/prompt-fields'
import { normalizeProviderEvent } from './agent-hook-listener/provider-dispatch'
import { hasExplicitUserPrompt } from './agent-hook-listener/provider-event-routing'
import { hasExplicitAmpPrompt } from './agent-hook-listener/providers/amp-events'
import { readString } from './agent-hook-listener/tool-input-preview'
/** Canonical transport-agnostic normalization entry shared by main and relay listeners. */
export function normalizeHookPayload(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string,
  options: { deferCompactOwnershipToClient?: boolean } = {}
): AgentHookEventPayload | null {
  const envelope = parseHookEnvelope(state, source, body, expectedEnv)
  if (!envelope) {
    return null
  }
  const { record, paneKey, hookPayloadRecord, tabId, worktreeId, launchToken } = envelope
  if (source === 'claude') {
    state.claudeUnconfirmedRestoredStatusPaneKeys.delete(paneKey)
  }
  const eventName =
    readFirstString(record, ['hook_event_name', 'hookEventName', 'hook_type', 'hookType']) ??
    hookPayloadRecord.hook_event_name ??
    hookPayloadRecord.hookEventName
  // Codex child hooks expose the child's session_id on the parent's pane.
  const providerSession =
    source === 'codex' && readString(hookPayloadRecord, 'agent_id')
      ? null
      : extractAgentProviderSession(source, hookPayloadRecord)
  const providerPromptId =
    source === 'claude' ? normalizeClaudePromptId(hookPayloadRecord.prompt_id) : undefined
  const compactTrigger =
    source === 'claude' &&
    (eventName === 'PreCompact' || eventName === 'PostCompact') &&
    (hookPayloadRecord.trigger === 'manual' || hookPayloadRecord.trigger === 'auto')
      ? hookPayloadRecord.trigger
      : undefined
  // Why: fail closed for Claude only. A malformed compact payload must not reach the mapping, but
  // the old guard was source-BLIND and pre-empted every other provider's normalizer before it ran.
  if (
    source === 'claude' &&
    (eventName === 'PreCompact' || eventName === 'PostCompact') &&
    compactTrigger === undefined
  ) {
    return null
  }
  const previousStatus = state.lastStatusByPaneKey.get(paneKey)
  // Why: only a MANUAL completion claims anything, so only it may write compact-scoped state. An
  // auto compact runs inside a turn that resumes and emits its own Stop; running the ownership
  // guard for it would burn the pane's consumed-compact slot on an event that maps to nothing.
  const isCompactCompletion =
    source === 'claude' && eventName === 'PostCompact' && compactTrigger === 'manual'
  if (isCompactCompletion) {
    // Why: a relay is a forwarder, not the authority on pane identity — pane retirement, tab
    // closure and hydrated rows all live on the client, and the client re-runs this exact guard on
    // ingest. Enforcing it on the relay too only adds a way to LOSE the event: the relay's cache is
    // per-process and capped, so a relay restart or an eviction silently drops the one signal that
    // can clear a remote pane. Ownership is deferred there, never skipped.
    if (options.deferCompactOwnershipToClient !== true) {
      if (
        isClaudeCompactCompletionConsumed(
          state.claudeConsumedCompactPromptIdByPaneKey,
          paneKey,
          providerPromptId
        ) ||
        !canAcceptClaudeCompactCompletion(previousStatus, {
          source,
          connectionId: null,
          providerPromptId,
          providerSession: providerSession ?? undefined
        })
      ) {
        return null
      }
      markClaudeCompactCompletionConsumed(
        state.claudeConsumedCompactPromptIdByPaneKey,
        paneKey,
        providerPromptId
      )
    }
    // Why: the compact's own event carries no prompt; keep the pane's label from the turn it
    // summarized rather than blanking the row as it clears.
    if (previousStatus?.payload.prompt && !state.lastPromptByPaneKey.has(paneKey)) {
      state.lastPromptByPaneKey.set(paneKey, previousStatus.payload.prompt)
    }
  }

  const extractedPrompt = extractPromptText(hookPayloadRecord)
  const promptText = extractedPrompt.text
  const dispatched = normalizeProviderEvent({
    state,
    source,
    eventName,
    promptText,
    paneKey,
    hookPayload: hookPayloadRecord,
    envelope: record,
    extractedPrompt
  })
  const providerSessionOnly =
    (source === 'pi' || source === 'prime-agent') &&
    eventName === 'session_start' &&
    providerSession !== null
  // A transcript session_start carries resume identity while idle; receivers discard the placeholder row.
  const transportPayload =
    dispatched.payload ??
    (providerSessionOnly
      ? normalizeAgentStatusPayload({ state: 'done', prompt: '', agentType: source })
      : null)
  const restoredUnconfirmed =
    source === 'claude' && state.claudeUnconfirmedRestoredStatusPaneKeys.delete(paneKey)
  if (!transportPayload) {
    return null
  }

  return {
    paneKey,
    source,
    launchToken,
    tabId,
    worktreeId,
    // Normalization is transport-agnostic; only ingestRemote knows the mux identity to stamp.
    connectionId: null,
    ...(restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
    hasExplicitPrompt:
      source === 'amp'
        ? hasExplicitAmpPrompt(eventName, promptText, hookPayloadRecord)
          ? true
          : undefined
        : hasExplicitUserPrompt(
            source,
            eventName,
            extractedPrompt,
            dispatched.resolvedPromptText,
            dispatched.hasTranscriptPromptEvidence
          ),
    promptInteractionKey: dispatched.promptInteractionKey,
    hookEventName: typeof eventName === 'string' ? eventName : undefined,
    providerPromptId,
    compactTrigger,
    toolUseId: readFirstString(hookPayloadRecord, ['tool_use_id', 'toolUseId']),
    toolAgentId: readFirstString(hookPayloadRecord, ['agent_id', 'agentId']),
    teammateName:
      source === 'claude' && eventName === 'TeammateIdle'
        ? readString(hookPayloadRecord, 'teammate_name')
        : undefined,
    toolAgentType: readString(hookPayloadRecord, 'agent_type'),
    ...(source === 'claude'
      ? {
          claudeRunningNonAgentTask:
            state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
            state.claudeActiveSessionCronPaneKeys.has(paneKey)
        }
      : {}),
    ...(providerSession ? { providerSession } : {}),
    ...(providerSessionOnly ? { providerSessionOnly: true } : {}),
    payload: transportPayload
  }
}
