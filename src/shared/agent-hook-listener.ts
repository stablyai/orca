import { readHookAgentProcess } from './agent-process-presence'
import { resolveAgentStatusIdentity } from './agent-status-identity'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'
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
import { readPaneProviderSession } from './agent-hook-listener/pane-provider-session'
/** Canonical transport-agnostic normalization entry shared by main and relay listeners. */
const CLAUDE_EXIT_SESSION_END_REASONS = new Set([
  'prompt_input_exit',
  'logout',
  'other',
  'bypass_permissions_disabled'
])

export function normalizeHookPayload(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string,
  options: {
    deferCompactOwnershipToClient?: boolean
    previousOpenCodeMainAgent?: AgentMainAgentStatus
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
    paneKey: stampedPaneKey,
    hookPayloadRecord,
    tabId: stampedTabId,
    worktreeId: stampedWorktreeId,
    launchToken: stampedLaunchToken
  } = envelope
  if (source === 'claude') {
    state.claudeUnconfirmedRestoredStatusPaneKeys.delete(stampedPaneKey)
  }
  const eventName =
    readFirstString(record, ['hook_event_name', 'hookEventName', 'hook_type', 'hookType']) ??
    hookPayloadRecord.hook_event_name ??
    hookPayloadRecord.hookEventName ??
    // Only jcode posts lifecycle under event; other providers may use that field for unrelated data.
    (source === 'jcode' ? hookPayloadRecord.event : undefined)
  const providerSession = readPaneProviderSession(state, source, stampedPaneKey, hookPayloadRecord)
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
  const previousReceivedAt =
    previousStatus &&
    'receivedAt' in previousStatus &&
    typeof previousStatus.receivedAt === 'number'
      ? previousStatus.receivedAt
      : previousStatus?.hostEvidenceObservedAt
  // Reject before provider folds mutate the pane's prompt, tool and child caches.
  if (
    previousStatus &&
    previousReceivedAt !== undefined &&
    sameAgentStatusTerminalOwner(
      { connectionId: previousStatus.connectionId ?? null, worktreeId: previousStatus.worktreeId },
      { connectionId: null, worktreeId }
    ) &&
    resolveAgentStatusIdentity({
      existing: {
        agentType: previousStatus.payload.agentType,
        state: previousStatus.payload.state,
        updatedAt: previousReceivedAt,
        restoredUnconfirmed: previousStatus.restoredUnconfirmed,
        agentPresence: previousStatus.providerSessionOnly ? undefined : previousStatus.agentPresence
      },
      incoming: source,
      incomingProcess: agentProcess,
      incomingSession: providerSession?.id,
      now: Date.now()
    }).inheritedFromActivePane
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
  const sessionEndReason = readString(hookPayloadRecord, 'reason')
  if (
    eventName === 'SessionEnd' &&
    agentPresence &&
    !readString(hookPayloadRecord, 'agent_id') &&
    // Only known process-exit reasons prove session death; /clear, /resume and unknown reasons do not.
    sessionEndReason !== undefined &&
    CLAUDE_EXIT_SESSION_END_REASONS.has(sessionEndReason)
  ) {
    const payload =
      previousStatus?.payload ??
      normalizeAgentStatusPayload({ state: 'done', prompt: '', agentType: source })
    if (!payload) {
      return null
    }
    return {
      paneKey,
      source,
      launchToken,
      tabId,
      worktreeId,
      connectionId: null,
      providerSession: providerSession ?? undefined,
      hookEventName: 'SessionEnd',
      agentPresence: { ...agentPresence, ended: true as const },
      payload
    }
  }

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

  return {
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
    toolUseId: readFirstString(hookPayloadRecord, ['tool_use_id', 'toolUseId']),
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
    ...(providerSessionOnly ? { providerSessionOnly: true } : {}),
    ...dispatched.hostTurnSignals,
    payload: transportPayload
  }
}
