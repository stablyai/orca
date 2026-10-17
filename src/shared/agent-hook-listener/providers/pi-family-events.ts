import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { continueMainAgentStatus } from '../../agent-lead-status-fold'
import { foldMainAgentWithRowChildWork } from '../../agent-hook-row-child-work-fold'
import { extractAgentProviderSession } from '../../agent-session-resume'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import type { ToolSnapshot } from '../listener-event'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

/** Maps a Pi-family hook event (Pi, OMP, Prime) onto a pane status: lifecycle
 *  events become `working` / `done`, an ask tool becomes `blocked`, and OMP's
 *  `model` stamp and the extension's live `subagents` ride along. Returns null
 *  for events that carry no status. */
export function normalizePiCompatibleEvent(
  state: HookListenerState,
  agentType: 'pi' | 'omp' | 'prime-agent',
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (agentType !== 'omp' && eventName === 'session_start') {
    // Why: Pi's session_start fires on TUI open/resume; discard stale turn details, no working row before user activity.
    clearPaneTurnCacheState(state, paneKey)
    // Why: a custom modal can switch sessions before its promise resolves.
    if (agentType !== 'pi' || hookPayload.ui_prompt_active !== true) {
      return null
    }
  }

  if (
    agentType === 'omp' &&
    eventName === 'subagents_update' &&
    Object.hasOwn(hookPayload, 'omp_status')
  ) {
    return normalizeOmpRegistrySnapshot(state, paneKey, hookPayload)
  }

  const ompPrevious = agentType === 'omp' ? state.lastStatusByPaneKey.get(paneKey) : undefined
  const ompSession = ompPrevious && extractAgentProviderSession('omp', hookPayload)
  const previousSession = ompPrevious?.providerSession
  const sameSession =
    ompSession?.transcriptPath &&
    ompSession.key === previousSession?.key &&
    ompSession.id === previousSession?.id &&
    ompSession.transcriptPath === previousSession?.transcriptPath
  const ompSessionChanged = ompSession?.transcriptPath && previousSession && !sameSession
  // Ordinary completion can precede the new scope's authoritative snapshot.
  if (ompSessionChanged) {
    clearPaneTurnCacheState(state, paneKey)
  }

  // Why: the OMP extension stamps `provider/id` on every post; Pi posts carry none.
  const model = readString(hookPayload, 'model')
  const modelSwitchCommand =
    hookPayload.model_switch_command === 'orca-model' ? 'orca-model' : undefined
  // Why: every post restates the extension's whole live roster, so an absent list means none.
  const subagents = hookPayload.subagents
  if (eventName === 'model_select' || eventName === 'subagents_update') {
    // Why: a model switch or a child ending happens between lead events, so it rides on the
    // pane's last visible row instead of inventing a state. Before any row exists there is
    // nothing to describe, and a providerSessionOnly placeholder is a hidden resume record.
    const previous =
      agentType === 'omp'
        ? ompSessionChanged
          ? undefined
          : ompPrevious
        : state.lastStatusByPaneKey.get(paneKey)
    if (
      !previous ||
      previous.providerSessionOnly === true ||
      previous.payload.agentType !== agentType ||
      (eventName === 'model_select' && !model)
    ) {
      return null
    }
    return normalizeAgentStatusPayload({
      ...previous.payload,
      ...(eventName === 'model_select' ? { model, modelSwitchCommand } : {}),
      subagents
    })
  }

  // Why: gate on the event's own tool_name so a stale cached question can't re-enter blocked.
  const toolName = readString(hookPayload, 'tool_name')
  const isPiCompatibleAsk =
    ((agentType === 'pi' && isAskUserQuestionTool(toolName)) ||
      (agentType === 'omp' && toolName === 'ask')) &&
    (eventName === 'tool_call' || eventName === 'tool_execution_start')
  // Why: unlike Codex's PermissionRequest, omp emits this only after its own policy engine already
  // resolved to "prompt", so a human is always the decider. The forwarded approval_mode is the
  // ambient mode, not the verdict -- it reads 'yolo' whenever tools.approval.<tool> prompts -- so
  // no value of it can downgrade this to working without hiding a real prompt.
  const isOmpApprovalRequest = agentType === 'omp' && eventName === 'tool_approval_requested'
  const isOmpApprovalResolution = agentType === 'omp' && eventName === 'tool_approval_resolved'
  const isPiUiPrompt =
    agentType === 'pi' && (eventName === 'ui_prompt_start' || hookPayload.ui_prompt_active === true)
  const isPiUiPromptEnd = agentType === 'pi' && eventName === 'ui_prompt_end'

  let stateName =
    isPiCompatibleAsk || isOmpApprovalRequest
      ? 'blocked'
      : isOmpApprovalResolution ||
          eventName === 'before_agent_start' ||
          eventName === 'agent_start' ||
          eventName === 'tool_call' ||
          eventName === 'tool_execution_start' ||
          eventName === 'tool_execution_end' ||
          eventName === 'message_end'
        ? 'working'
        : eventName === 'agent_end'
          ? 'done'
          : null

  if (isPiUiPrompt) {
    // Why: waiting uses the same orange question icon as Claude/Codex input prompts.
    stateName = 'waiting'
  } else if (isPiUiPromptEnd) {
    stateName = hookPayload.is_idle === true ? 'done' : 'working'
  }

  if (
    !stateName ||
    (stateName === 'working' &&
      !ompSessionChanged &&
      holdsOmpApproval(state, agentType, eventName, paneKey))
  ) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields(agentType, eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent(agentType, eventName) }
  )

  // The root settled before its children; the ordinary aggregate end cannot redate that fact.
  const isOrdinaryOmpEnd =
    agentType === 'omp' && eventName === 'agent_end' && hookPayload.session_boundary !== true
  let settledMainAgent =
    isOrdinaryOmpEnd &&
    sameSession &&
    ompPrevious?.payload.agentType === 'omp' &&
    ompPrevious.payload.mainAgent?.state === 'done'
      ? ompPrevious.payload.mainAgent
      : undefined
  if (isOrdinaryOmpEnd && ompSessionChanged) {
    // A done-to-done scope replacement cannot borrow the old aggregate row clock.
    settledMainAgent = continueMainAgentStatus(undefined, { state: 'done' }, Date.now())
  }

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent(agentType, eventName)
    }),
    agentType,
    model,
    modelSwitchCommand,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    subagents,
    mainAgent: settledMainAgent,
    // Why: the extension ends a run whose session was replaced; that is not a completed turn.
    ...(eventName === 'agent_end' && hookPayload.session_boundary === true
      ? { sessionBoundary: true }
      : {})
  })
}

/** Native root evidence can restore a missed row, but never borrow another session's details. */
function normalizeOmpRegistrySnapshot(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const rawRoot = hookPayload.omp_status
  if (typeof rawRoot !== 'object' || rawRoot === null || Array.isArray(rawRoot)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Shape-checked hook JSON object; its fields remain unknown until normalized.
  const rootPayload = rawRoot as Record<string, unknown>
  const root = normalizeAgentStatusPayload({ state: rootPayload.state })
  if (!root) {
    return null
  }
  const session = extractAgentProviderSession('omp', hookPayload)
  const previous = state.lastStatusByPaneKey.get(paneKey)
  if (!session?.transcriptPath || (previous && previous.payload.agentType !== 'omp')) {
    return null
  }
  const previousSession = previous?.providerSession
  const sessionChanged =
    previousSession !== undefined &&
    (previousSession.key !== session.key ||
      previousSession.id !== session.id ||
      (previousSession.transcriptPath !== undefined &&
        previousSession.transcriptPath !== session.transcriptPath))
  if (sessionChanged && rootPayload.session_boundary !== true) {
    return null
  }
  const previousPayload = sessionChanged ? undefined : previous?.payload
  const previousRootState = previousPayload?.mainAgent?.state ?? previousPayload?.state
  // Native busy evidence is not proof that a human answered an outstanding root prompt.
  const heldInputState =
    root.state === 'working' &&
    rootPayload.input_pending !== false &&
    (previousRootState === 'blocked' || previousRootState === 'waiting')
      ? previousRootState
      : undefined
  const rootState = heldInputState ?? root.state
  if (!previousPayload) {
    clearPaneTurnCacheState(state, paneKey)
  } else if (heldInputState === undefined && !state.lastToolByPaneKey.has(paneKey)) {
    resolveToolState(state, paneKey, previousPayload, { resetOnNewTurn: false })
  }
  let toolUpdate: ToolSnapshot
  if (heldInputState !== undefined && previousPayload) {
    toolUpdate = {
      toolName: previousPayload.toolName,
      toolInput: previousPayload.toolInput,
      interactivePrompt: previousPayload.interactivePrompt,
      lastAssistantMessage: previousPayload.lastAssistantMessage,
      lastAssistantMessageIsToolOutput: previousPayload.lastAssistantMessageIsToolOutput,
      hasToolUpdate: true,
      hasToolInputField: true,
      clearLastAssistantMessage: previousPayload.lastAssistantMessage === undefined
    }
  } else {
    const hasToolFields =
      Object.hasOwn(rootPayload, 'tool_name') || Object.hasOwn(rootPayload, 'tool_input')
    const toolFields = hasToolFields
      ? extractToolFields(
          'omp',
          rootState === 'blocked' || rootState === 'waiting'
            ? 'tool_execution_start'
            : 'tool_execution_end',
          rootPayload
        )
      : {
          interactivePrompt:
            rootState === 'blocked' || rootState === 'waiting'
              ? previousPayload?.interactivePrompt
              : undefined
        }
    toolUpdate = { ...toolFields, ...extractToolFields('omp', 'message_end', rootPayload) }
  }
  const snapshot = resolveToolState(state, paneKey, toolUpdate, { resetOnNewTurn: false })
  const previousMainAgent =
    previousPayload?.mainAgent ??
    (previousPayload &&
    previous &&
    'stateStartedAt' in previous &&
    typeof previous.stateStartedAt === 'number' &&
    Number.isFinite(previous.stateStartedAt)
      ? { state: previousPayload.state, stateStartedAt: previous.stateStartedAt }
      : undefined)
  const mainAgent = continueMainAgentStatus(
    previousMainAgent,
    {
      state: rootState,
      ...(rootState === 'done' && previousMainAgent?.state === 'done'
        ? { outcome: previousPayload?.mainAgent?.outcome }
        : {})
    },
    Date.now()
  )
  const payload = normalizeAgentStatusPayload({
    ...previousPayload,
    state: rootState,
    agentType: 'omp',
    prompt: resolvePrompt(
      state,
      paneKey,
      heldInputState !== undefined
        ? (previousPayload?.prompt ?? '')
        : (readString(rootPayload, 'prompt') ?? previousPayload?.prompt ?? '')
    ),
    model: readString(hookPayload, 'model') ?? previousPayload?.model,
    modelSwitchCommand:
      hookPayload.model_switch_command === 'orca-model'
        ? 'orca-model'
        : previousPayload?.modelSwitchCommand,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    sessionBoundary: rootPayload.session_boundary === true,
    subagents: hookPayload.subagents,
    mainAgent
  })
  if (!payload) {
    return null
  }
  const { stateName, workingMode } = foldMainAgentWithRowChildWork(rootState, { payload })
  return {
    ...payload,
    state: stateName,
    workingMode,
    interrupted: stateName === 'done' ? payload.interrupted : undefined,
    sessionBoundary: stateName === 'done' ? payload.sessionBoundary : undefined,
    turnCompletedAt:
      stateName === 'working' || stateName === 'done' ? payload.turnCompletedAt : undefined
  }
}

const OMP_APPROVAL_RELEASE_EVENTS: ReadonlySet<unknown> = new Set([
  'tool_approval_resolved',
  'before_agent_start',
  'agent_start'
])

/**
 * Whether an OMP approval wait must survive this working event. omp posts `tool_execution_start`
 * right after `tool_approval_requested`, while its Approve/Deny select still holds the human, so
 * only the resolution (or a new turn) ends the wait. An `ask` row is its own tool's wait, which
 * `tool_execution_end` ends.
 */
function holdsOmpApproval(
  state: HookListenerState,
  agentType: 'pi' | 'omp' | 'prime-agent',
  eventName: unknown,
  paneKey: string
): boolean {
  if (agentType !== 'omp' || OMP_APPROVAL_RELEASE_EVENTS.has(eventName)) {
    return false
  }
  const previous = state.lastStatusByPaneKey.get(paneKey)?.payload
  return (
    previous?.agentType === 'omp' && previous.state === 'blocked' && previous.toolName !== 'ask'
  )
}
