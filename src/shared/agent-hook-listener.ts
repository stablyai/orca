import { normalizeClaudeSessionEnd } from './agent-hook-listener/claude-session-end'
import { projectClaudePermissionState } from './agent-hook-listener/claude-permission-projection'
import { observeClaudePermissionEvent } from './agent-hook-listener/claude-permission-state'
import { readHookAgentProcess } from './agent-process-presence'
import { isInheritedHookStatus } from './agent-hook-presence-transition'
import { normalizeAgentStatusPayload, type AgentMainAgentStatus } from './agent-status-types'
import type { AgentHookSource } from './agent-hook-relay'
import {
  canAcceptClaudeCompactCompletion,
  isClaudeCompactCompletionConsumed,
  markClaudeCompactCompletionConsumed
} from './claude-compact-completion'
import { parseHookEnvelope } from './agent-hook-listener/hook-envelope'
import { readFirstString } from './agent-hook-listener/interactive-tool'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import {
  normalizeClaudePromptId,
  normalizeGrokPromptId
} from './agent-hook-listener/listener-limits'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import { extractPromptText } from './agent-hook-listener/prompt-fields'
import { normalizeProviderEvent } from './agent-hook-listener/provider-dispatch'
import { hasExplicitUserPrompt } from './agent-hook-listener/provider-event-routing'
import { hasExplicitAmpPrompt } from './agent-hook-listener/providers/amp-events'
import {
  isOpenCodeSharedServerPost,
  resolveOpenCodeSharedServerEnvelope,
  suppressOpenCodeSharedServerPost,
  trackOpenCodePaneLaunchToken
} from './agent-hook-listener/opencode-session-registry'
import { claudeRowHasUnlistedLiveWork } from './agent-hook-listener/providers/claude-pane-hold-evidence'
import { readString } from './agent-hook-listener/tool-input-preview'
import {
  hasSeparateHookSessionAdmission,
  readPaneSessionContext
} from './agent-hook-listener/pane-provider-session'
/** Canonical transport-agnostic normalization entry shared by main and relay listeners. */

export function normalizeHookPayload(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string,
  options: {
    isReplay?: boolean
    deferCompactOwnershipToClient?: boolean
    previousOpenCodeMainAgent?: AgentMainAgentStatus
    bindingStatusByPaneKey?: ReadonlyMap<string, AgentHookEventPayload>
    admitOpenCodeTui?: (
      identity: Pick<
        AgentHookEventPayload,
        'paneKey' | 'launchToken' | 'hookEventName' | 'hasExplicitPrompt'
      >
    ) => boolean | 'preserve-poster'
  } = {}
): AgentHookEventPayload | null {
  const envelope = parseHookEnvelope(state, source, body, expectedEnv)
  if (!envelope) {
    return null
  }
  const {
    record,
    eventName,
    paneKey: stampedPaneKey,
    hookPayloadRecord,
    tabId: stampedTabId,
    worktreeId: stampedWorktreeId,
    launchToken: stampedLaunchToken
  } = envelope
  if (source === 'claude') {
    state.claudeUnconfirmedRestoredStatusPaneKeys.delete(stampedPaneKey)
  }
  const sessions = readPaneSessionContext(state, source, envelope, eventName)
  const { providerSession, statusAdmissionSession } = sessions
  if (source === 'opencode' && record.opencodeTui === 1 && !providerSession) {
    return null
  }
  if (suppressOpenCodeSharedServerPost(state, source, record, providerSession?.id)) {
    return null
  }
  const extractedPrompt = extractPromptText(hookPayloadRecord)
  // A TUI's physical launch must pass the host fence before borrowing its creator's identity.
  const tuiAdmission =
    source === 'opencode' && record.opencodeTui === 1 && isOpenCodeSharedServerPost(source, record)
      ? options.admitOpenCodeTui?.({
          paneKey: stampedPaneKey,
          launchToken: stampedLaunchToken,
          hookEventName: typeof eventName === 'string' ? eventName : undefined,
          hasExplicitPrompt: hasExplicitUserPrompt(
            source,
            eventName,
            extractedPrompt,
            extractedPrompt.text
          )
        })
      : undefined
  if (tuiAdmission === false) {
    return null
  }
  // Rewrite frozen OpenCode1 server stamps before status/routing/fences use the wrong pane (#21359).
  const stamped = {
    paneKey: stampedPaneKey,
    tabId: stampedTabId,
    worktreeId: stampedWorktreeId,
    launchToken: stampedLaunchToken
  }
  const { paneKey, tabId, worktreeId, launchToken } =
    tuiAdmission === 'preserve-poster'
      ? stamped
      : resolveOpenCodeSharedServerEnvelope({
          state,
          source,
          stamped,
          sessionId: providerSession?.id,
          body: record
        })
  // Track only resolved tokens or stale shared-server stamps can poison the live pane cache.
  if (tuiAdmission !== 'preserve-poster') {
    trackOpenCodePaneLaunchToken(state, paneKey, launchToken)
  }
  const providerPromptId =
    source === 'claude'
      ? normalizeClaudePromptId(hookPayloadRecord.prompt_id)
      : source === 'grok'
        ? normalizeGrokPromptId(hookPayloadRecord.promptId ?? hookPayloadRecord.prompt_id)
        : undefined
  const compactTrigger =
    source === 'claude' &&
    (eventName === 'PreCompact' || eventName === 'PostCompact') &&
    (hookPayloadRecord.trigger === 'manual' || hookPayloadRecord.trigger === 'auto')
      ? hookPayloadRecord.trigger
      : undefined
  // Reject malformed Claude compacts without suppressing other providers' normalizers.
  if (
    source === 'claude' &&
    (eventName === 'PreCompact' || eventName === 'PostCompact') &&
    compactTrigger === undefined
  ) {
    return null
  }
  const previousStatus = state.lastStatusByPaneKey.get(paneKey)
  const agentProcess = readHookAgentProcess(source, record.agentProcess)
  const admissionStatus =
    hasSeparateHookSessionAdmission(source) && options.bindingStatusByPaneKey
      ? options.bindingStatusByPaneKey.get(paneKey)
      : previousStatus
  if (
    isInheritedHookStatus(
      {
        paneKey,
        worktreeId,
        connectionId: null,
        providerSession: providerSession ?? undefined,
        statusAdmissionSession,
        agentPresence: agentProcess ? { agent: source, process: agentProcess } : undefined,
        payload: { agentType: source, state: 'working', prompt: '' }
      },
      admissionStatus
    )
  ) {
    return null
  }
  // Only manual PostCompact clears a turn; auto compaction must not consume its ownership slot.
  const isCompactCompletion =
    source === 'claude' && eventName === 'PostCompact' && compactTrigger === 'manual'
  if (isCompactCompletion) {
    // Relay restarts/evictions lose ownership evidence; defer the guard to client ingest, which owns pane retirement and hydrated rows.
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
    // Compacts have no prompt; retain the summarized turn's label.
    if (previousStatus?.payload.prompt && !state.lastPromptByPaneKey.has(paneKey)) {
      state.lastPromptByPaneKey.set(paneKey, previousStatus.payload.prompt)
    }
  }

  const agentPresence = agentProcess
    ? { agent: source, process: agentProcess, sessionOwner: true as const }
    : undefined
  const sessionEnd = normalizeClaudeSessionEnd(
    state,
    source,
    envelope,
    providerSession,
    agentPresence,
    previousStatus
  )
  if (sessionEnd) {
    return sessionEnd
  }

  const permissionObservation =
    source === 'claude'
      ? observeClaudePermissionEvent(
          state,
          paneKey,
          eventName,
          hookPayloadRecord,
          launchToken,
          options.isReplay === true
        )
      : undefined
  const promptText = extractedPrompt.text
  const dispatched = normalizeProviderEvent({
    state,
    source,
    eventName,
    promptText,
    paneKey,
    hookPayload: hookPayloadRecord,
    envelope: record,
    extractedPrompt,
    previousOpenCodeMainAgent: options.previousOpenCodeMainAgent
  })
  const providerSessionOnly =
    (source === 'pi' || source === 'prime-agent' || source === 'jcode') &&
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
  const grokActiveTurn = source === 'grok' ? state.grokActiveTurnByPaneKey.get(paneKey) : undefined

  const normalized: AgentHookEventPayload = {
    paneKey,
    source,
    agentPresence,
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
            dispatched.eventName,
            extractedPrompt,
            dispatched.resolvedPromptText,
            dispatched.hasTranscriptPromptEvidence
          ),
    promptInteractionKey: dispatched.promptInteractionKey,
    hookEventName: typeof dispatched.eventName === 'string' ? dispatched.eventName : undefined,
    providerPromptId:
      source === 'grok' ? (grokActiveTurn?.promptId ?? providerPromptId) : providerPromptId,
    grokPromptBoundary: grokActiveTurn ? true : undefined,
    compactTrigger,
    toolUseId:
      permissionObservation?.toolUseId ??
      readFirstString(hookPayloadRecord, ['tool_use_id', 'toolUseId']),
    ...(permissionObservation?.settled
      ? { claudeSettledRequests: permissionObservation.settled }
      : {}),
    toolAgentId: readFirstString(hookPayloadRecord, ['agent_id', 'agentId']),
    teammateName:
      source === 'claude' && eventName === 'TeammateIdle'
        ? readString(hookPayloadRecord, 'teammate_name')
        : undefined,
    toolAgentType: readString(hookPayloadRecord, 'agent_type'),
    ...(source === 'claude'
      ? {
          claudeRunningNonAgentTask: claudeRowHasUnlistedLiveWork(state, paneKey)
        }
      : {}),
    ...(providerSession ? { providerSession } : {}),
    ...(statusAdmissionSession ? { statusAdmissionSession } : {}),
    ...(providerSessionOnly ? { providerSessionOnly: true } : {}),
    ...dispatched.hostTurnSignals,
    payload: transportPayload
  }
  return source === 'claude' ? projectClaudePermissionState(state, normalized) : normalized
}
