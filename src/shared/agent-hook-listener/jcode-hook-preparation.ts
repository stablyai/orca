import { normalizeAgentStatusPayload, type ParsedAgentStatusPayload } from '../agent-status-types'
import { parseHookEnvelope } from './hook-envelope'
import { inheritsActiveHookPaneIdentity } from './hook-pane-identity'
import { readFirstString } from './interactive-tool'
import { readString } from './tool-input-preview'
import {
  commitJcodeSessionResolution,
  resolveJcodeSessionEvent,
  type JcodeSessionResolution
} from './jcode-session-registry'
import { clearReplacedJcodeRoot, prepareJcodeState } from './jcode-prepared-state'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import { extractPromptText } from './prompt-fields'
import { normalizeProviderEvent } from './provider-dispatch'
import { hasExplicitUserPrompt } from './provider-event-routing'
import { settleJcodeRootTurn, shouldIgnoreJcodeEvent } from './providers/jcode-events'
import { normalizeJcodeWorkerEvent } from './providers/jcode-roster-state'
import { hasOtherAgentProcessOwner } from '../agent-process-presence'
import { sameAgentStatusTerminalOwner } from '../agent-status-terminal-owner'
import { reapUnconfirmedRestoredJcodeSubagents } from '../jcode-subagent-roster'
import { findJcodePendingInput } from './jcode-pending-input-queue'
import { copyRegistry } from './jcode-session-ownership'

export type PreparedJcodeHook = {
  resolution: JcodeSessionResolution
  admission: Pick<
    AgentHookEventPayload,
    | 'paneKey'
    | 'launchToken'
    | 'hookEventName'
    | 'hasExplicitPrompt'
    | 'isReplay'
    | 'agentPresence'
    | 'worktreeId'
  >
  event: AgentHookEventPayload | null
  commit: () => void
}

export function prepareJcodeHookPayload(
  state: HookListenerState,
  body: unknown,
  expectedEnv: string,
  options: { isReplay?: boolean; receivedAt?: number; generation?: number } = {}
): PreparedJcodeHook | null {
  const warnings = {
    ...state,
    warnedVersions: new Set(state.warnedVersions),
    warnedEnvs: new Set(state.warnedEnvs)
  }
  const envelope = parseHookEnvelope(warnings, 'jcode', body, expectedEnv)
  if (!envelope) {
    return null
  }
  const {
    record,
    paneKey,
    hookPayloadRecord: hookPayload,
    tabId,
    worktreeId,
    launchToken
  } = envelope
  const eventName =
    readFirstString(record, ['hook_event_name', 'hookEventName', 'hook_type', 'hookType']) ??
    hookPayload.hook_event_name ??
    hookPayload.hookEventName ??
    hookPayload.event
  if (typeof eventName !== 'string') {
    return null
  }
  if (
    inheritsActiveHookPaneIdentity(
      state.lastStatusByPaneKey.get(paneKey),
      'jcode',
      worktreeId,
      undefined,
      readString(hookPayload, 'session_id')
    )
  ) {
    return null
  }
  const owner = state.lastStatusByPaneKey.get(paneKey)
  if (
    owner &&
    !owner.providerSessionOnly &&
    sameAgentStatusTerminalOwner(owner, { connectionId: null, worktreeId }) &&
    hasOtherAgentProcessOwner(owner.agentPresence, { agent: 'jcode' })
  ) {
    return null
  }
  const prepared = prepareJcodeState(state, paneKey, warnings)
  const { draft } = prepared
  const input = {
    body,
    receivedAt: options.receivedAt ?? Date.now(),
    isReplay: options.isReplay,
    generation: options.generation
  }
  const resolution = resolveJcodeSessionEvent(
    draft,
    paneKey,
    eventName,
    hookPayload,
    Date.now(),
    input
  )
  const admission: PreparedJcodeHook['admission'] = {
    paneKey,
    worktreeId,
    launchToken,
    hookEventName: resolution.kind === 'worker' ? undefined : eventName,
    isReplay: options.isReplay
  }
  let event: AgentHookEventPayload | null = null
  if (resolution.kind === 'root' || resolution.kind === 'worker') {
    const rootId = resolution.binding.rootSessionId
    clearReplacedJcodeRoot(draft, paneKey, rootId)
    const base = {
      paneKey,
      source: 'jcode' as const,
      launchToken,
      tabId,
      worktreeId,
      connectionId: null,
      isReplay: options.isReplay,
      providerSession: { key: 'session_id' as const, id: rootId }
    }
    if (resolution.kind === 'worker') {
      const payload = normalizeJcodeWorkerEvent(draft, paneKey, eventName, hookPayload, resolution)
      if (payload) {
        event = { ...base, payload }
      }
    } else {
      if (shouldIgnoreJcodeEvent(draft, eventName, paneKey, rootId)) {
        const queuedIndex = findJcodePendingInput(state.jcodeSessions.pending, input)
        if (queuedIndex < 0) {
          return null
        }
        const dropped = prepareJcodeState(state, paneKey)
        dropped.draft.jcodeSessions = copyRegistry(state.jcodeSessions)
        dropped.draft.jcodeSessions.pending.splice(queuedIndex, 1)
        return { resolution, admission, event: null, commit: dropped.commit }
      }
      if (eventName === 'turn_start' || eventName === 'turn_end' || eventName === 'session_end') {
        const roster = draft.jcodeSubagentRosterByPaneKey.get(paneKey)
        if (roster) {
          reapUnconfirmedRestoredJcodeSubagents(roster)
        }
      }
      const turn = draft.jcodeTurnByPaneKey.get(paneKey)
      const lateEnd = eventName === 'turn_end' && turn?.settled === true && !turn.active
      const extractedPrompt = extractPromptText(hookPayload)
      const dispatched = normalizeProviderEvent({
        state: draft,
        source: 'jcode',
        eventName,
        promptText: extractedPrompt.text,
        paneKey,
        hookPayload,
        envelope: record,
        extractedPrompt
      })
      if (eventName === 'session_end' && turn?.active && !dispatched.payload) {
        return null
      }
      const providerSessionOnly = eventName === 'session_start'
      const payload =
        dispatched.payload ??
        (providerSessionOnly
          ? normalizeAgentStatusPayload({ state: 'done', prompt: '', agentType: 'jcode' })
          : null)
      if (payload) {
        event = {
          ...base,
          payload,
          ...(providerSessionOnly ? { providerSessionOnly: true } : {}),
          ...(!lateEnd
            ? {
                hookEventName: eventName,
                hasExplicitPrompt: hasExplicitUserPrompt(
                  'jcode',
                  eventName,
                  extractedPrompt,
                  dispatched.resolvedPromptText,
                  dispatched.hasTranscriptPromptEvidence
                ),
                promptInteractionKey: dispatched.promptInteractionKey,
                ...dispatched.hostTurnSignals
              }
            : {})
        }
        admission.hookEventName = event.hookEventName
        admission.hasExplicitPrompt = event.hasExplicitPrompt
      }
      if (eventName === 'session_end') {
        draft.jcodeRootPayloadByPaneKey.delete(paneKey)
      }
    }
  }
  commitJcodeSessionResolution(draft, resolution)
  return { resolution, admission, event, commit: prepared.commit }
}

export function prepareJcodeRootSettlement(
  state: HookListenerState,
  paneKey: string,
  sessionId: string,
  revision: number
): { payload: ParsedAgentStatusPayload; commit: () => void } | null {
  const prepared = prepareJcodeState(state, paneKey)
  const payload = settleJcodeRootTurn(prepared.draft, paneKey, sessionId, revision)
  return payload ? { payload, commit: prepared.commit } : null
}
