import {
  readClaudePermissionObservation,
  type ClaudePermissionObservation
} from './claude-permission-transcript-records'
import { isSameAgentProcess, type AgentProcessIdentity } from '../../agent-process-presence'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { readFirstString } from '../interactive-tool'
import { buildClaudeStatusPayload } from './claude-status-build'
import { resolveClaudePaneStatus, setClaudeMainAgentTurnState } from './claude-roster-state'

/** Bind on the execution host before normalization replaces the preceding PreToolUse row. */
export function prepareClaudePermissionObservation(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hook: Record<string, unknown>,
  launchToken?: string,
  process?: AgentProcessIdentity
): Record<string, unknown> {
  if (readFirstString(hook, ['agent_id', 'agentId'])) {
    return hook
  }
  if (eventName !== 'PermissionRequest') {
    return hook
  }
  const sessionId = readFirstString(hook, ['session_id', 'sessionId'])
  const filePath = readFirstString(hook, ['transcript_path', 'transcriptPath'])
  const toolName = readFirstString(hook, ['tool_name', 'toolName'])
  state.claudePermissionObservationByPaneKey.delete(paneKey)
  if (!sessionId || !filePath || !toolName || isAskUserQuestionTool(toolName)) {
    return hook
  }
  const previous = state.lastStatusByPaneKey.get(paneKey)
  const candidate =
    previous?.hookEventName === 'PreToolUse' &&
    previous.providerSession?.id === sessionId &&
    previous.launchToken === launchToken &&
    !previous.restoredUnconfirmed &&
    !previous.isReplay &&
    !previous.toolAgentId
      ? previous.toolUseId
      : undefined
  const observation: ClaudePermissionObservation = {
    toolAgentType: readFirstString(hook, ['agent_type']),
    cursor: { filePath, offset: 0, carry: '' },
    sessionId,
    launchToken,
    process,
    toolName,
    input: hook.tool_input,
    toolUseId: readFirstString(hook, ['tool_use_id', 'toolUseId']) ?? candidate,
    requiresUniqueInput: !readFirstString(hook, ['tool_use_id', 'toolUseId']),
    promptId: readFirstString(hook, ['prompt_id']),
    descendants: new Set(),
    anchored: false,
    result: false,
    proof: 'pending',
    verdict: 'working',
    failures: 0
  }
  readClaudePermissionObservation(observation, false)
  if (!observation.anchored && observation.requiresUniqueInput) {
    observation.toolUseId = undefined
  }
  state.claudePermissionObservationByPaneKey.set(paneKey, observation)
  return observation.anchored && observation.toolUseId
    ? { ...hook, tool_use_id: observation.toolUseId }
    : hook
}

export function hasClaudePermissionObservation(
  state: HookListenerState,
  event: AgentHookEventPayload
): boolean {
  const observation = state.claudePermissionObservationByPaneKey.get(event.paneKey)
  const lead = state.claudeLeadStateByPaneKey.get(event.paneKey)
  const valid =
    observation &&
    lead &&
    event.payload.agentType === 'claude' &&
    !event.connectionId &&
    !event.isReplay &&
    !event.restoredUnconfirmed &&
    !event.providerSessionOnly &&
    !event.agentPresence?.ended &&
    event.providerSession?.id === observation.sessionId &&
    event.launchToken === observation.launchToken &&
    (!observation.process ||
      (event.agentPresence?.process &&
        isSameAgentProcess(observation.process, event.agentPresence.process))) &&
    !lead.waitingAgentId &&
    (observation.published
      ? lead === observation.lead
      : lead.state === 'waiting' &&
        (lead.waitingToolUseId === undefined || lead.waitingToolUseId === observation.toolUseId))
  if (!valid) {
    state.claudePermissionObservationByPaneKey.delete(event.paneKey)
  }
  return Boolean(valid)
}

/** Propose a normal host-store transition; producer caches change only after that row is admitted. */
export function pollClaudePermissionTranscript(
  state: HookListenerState,
  original: AgentHookEventPayload
): { event: AgentHookEventPayload; onAccepted: () => boolean } | undefined {
  if (!hasClaudePermissionObservation(state, original)) {
    return undefined
  }
  const observation = state.claudePermissionObservationByPaneKey.get(original.paneKey)
  const lead = state.claudeLeadStateByPaneKey.get(original.paneKey)
  if (!observation || !lead) {
    return undefined
  }
  const proof = readClaudePermissionObservation(observation)
  if (!proof) {
    if (observation.failures >= 3) {
      state.claudePermissionObservationByPaneKey.delete(original.paneKey)
    }
    return undefined
  }
  const retire = proof === 'lost'
  const verdict = proof === 'complete' ? observation.verdict : 'working'
  if (retire && !observation.result) {
    state.claudePermissionObservationByPaneKey.delete(original.paneKey)
    return undefined
  }
  if (!observation.toolUseId || !observation.anchored) {
    return undefined
  }
  const binding = !observation.published && original.toolUseId !== observation.toolUseId
  if (!binding && (!observation.result || observation.published === verdict)) {
    if (retire || (observation.superseded && observation.published === 'working')) {
      state.claudePermissionObservationByPaneKey.delete(original.paneKey)
    }
    return undefined
  }
  const view = {
    ...state,
    claudeLeadStateByPaneKey: new Map([[original.paneKey, lead]]),
    lastToolByPaneKey: new Map([
      [original.paneKey, state.lastToolByPaneKey.get(original.paneKey) ?? {}]
    ])
  }
  const record = setClaudeMainAgentTurnState(
    view,
    original.paneKey,
    binding
      ? {
          ...lead,
          state: 'waiting',
          waitingToolUseId: observation.toolUseId
        }
      : {
          state: verdict === 'working' ? 'working' : 'done',
          ...(verdict === 'cancellation' ? { outcome: 'cancellation' as const } : {})
        }
  )
  if (!binding) {
    view.lastToolByPaneKey.set(original.paneKey, {
      ...state.lastToolByPaneKey.get(original.paneKey),
      toolName: undefined,
      toolInput: undefined,
      interactivePrompt: undefined
    })
  }
  const payload = buildClaudeStatusPayload(
    view,
    undefined,
    '',
    original.paneKey,
    {},
    {
      ...resolveClaudePaneStatus(view, original.paneKey, record),
      updateToolSnapshot: false
    }
  )
  if (!payload) {
    return undefined
  }
  const finished = retire || verdict !== 'working' || observation.superseded
  return {
    event: {
      ...original,
      hasExplicitPrompt: undefined,
      hookEventName: binding ? original.hookEventName : undefined,
      toolUseId: observation.toolUseId,
      toolAgentId: undefined,
      toolAgentType: observation.toolAgentType,
      ...(binding
        ? {}
        : {
            claudeSettledRequests: [
              {
                toolUseId: observation.toolUseId,
                ...(observation.toolAgentType ? { toolAgentType: observation.toolAgentType } : {})
              }
            ]
          }),
      payload: { ...original.payload, ...payload, model: original.payload.model }
    },
    onAccepted: () => {
      if (
        state.claudePermissionObservationByPaneKey.get(original.paneKey) !== observation ||
        state.claudeLeadStateByPaneKey.get(original.paneKey) !== lead
      ) {
        return false
      }
      state.claudeLeadStateByPaneKey.set(original.paneKey, record)
      state.lastToolByPaneKey.set(
        original.paneKey,
        view.lastToolByPaneKey.get(original.paneKey) ?? {}
      )
      observation.lead = record
      if (!binding) {
        observation.published = verdict
      }
      if (!binding && finished) {
        state.claudePermissionObservationByPaneKey.delete(original.paneKey)
      }
      return true
    }
  }
}

/** Complete the existing ID-bind/settle path only after canonical admission has returned. */
export function applyClaudePermissionTranscript<T extends AgentHookEventPayload>(
  state: HookListenerState,
  original: T,
  apply: (event: AgentHookEventPayload, onAccepted: () => void) => T | undefined
): T | undefined {
  const observation = state.claudePermissionObservationByPaneKey.get(original.paneKey)
  let current: T | undefined = original
  for (let step = 0; step < 2 && current; step++) {
    if (state.lastStatusByPaneKey.get(original.paneKey) !== current) {
      break
    }
    const proposal = pollClaudePermissionTranscript(state, current)
    if (!proposal) {
      break
    }
    let accepted = false
    const next = apply(proposal.event, () => {
      accepted = proposal.onAccepted()
    })
    current = next
    if (
      !accepted ||
      !next ||
      next === original ||
      state.lastStatusByPaneKey.get(original.paneKey) !== next
    ) {
      break
    }
    if (observation?.proof !== 'lost' || observation.published) {
      return next
    }
  }
  if (
    observation?.proof === 'lost' &&
    state.claudePermissionObservationByPaneKey.get(original.paneKey) === observation
  ) {
    state.claudePermissionObservationByPaneKey.delete(original.paneKey)
  }
  return current
}

/** Child refreshes retain the request's identity while the producer still owns that wait. */
export function claudeWaitingRequestIdentity(
  state: HookListenerState,
  source: string,
  paneKey: string,
  eventName: unknown
): Partial<AgentHookEventPayload> | undefined {
  const previous = state.lastStatusByPaneKey.get(paneKey)
  if (
    source !== 'claude' ||
    state.claudeLeadStateByPaneKey.get(paneKey)?.state !== 'waiting' ||
    previous?.hookEventName !== 'PermissionRequest' ||
    eventName === 'PermissionRequest'
  ) {
    return undefined
  }
  return {
    hookEventName: previous.hookEventName,
    toolUseId: previous.toolUseId,
    toolAgentId: previous.toolAgentId,
    toolAgentType: previous.toolAgentType,
    providerPromptId: previous.providerPromptId
  }
}
