import { afterEach, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import ts from 'typescript-api'
import * as statusTypes from './agent-status-types'
import * as questionTools from './agent-question-answered-intent'
import * as listenerState from './agent-hook-listener/listener-state'
import * as promptFields from './agent-hook-listener/prompt-fields'
import * as eventRouting from './agent-hook-listener/provider-event-routing'
import * as toolPreview from './agent-hook-listener/tool-input-preview'
import * as planReview from './omp-plan-review-prompt'
import type { normalizePiCompatibleEvent } from './agent-hook-listener/providers/pi-family-events'
import { normalizeHookPayload } from './agent-hook-listener'
import { cacheRelayLegacyAgentStatus } from './agent-status-legacy-relay-cache'
import { makePaneKey } from './stable-pane-id'
import { createAgentStatusExtensionHarness } from '../main/pi/agent-status-extension-test-harness'

// Frozen execution-host fold from 6d473f4bea1d; its ordinary-event attention limit stays visible.
const oldReceiverSource = `import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { parseOmpPlanReviewPrompt } from '../../omp-plan-review-prompt'

/** Maps a Pi-family hook event (Pi, OMP, Prime) onto a pane status: lifecycle
 *  events become \`working\` / \`done\`, an ask tool becomes \`blocked\`, and OMP's
 *  \`model\` stamp and the extension's live \`subagents\` ride along. Returns null
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

  // Why: the OMP extension stamps \`provider/id\` on every post; Pi posts carry none.
  const model = readString(hookPayload, 'model')
  const modelSwitchCommand =
    hookPayload.model_switch_command === 'orca-model' ? 'orca-model' : undefined
  // Why: every post restates the extension's whole live roster, so an absent list means none.
  const subagents = hookPayload.subagents
  if (eventName === 'model_select' || eventName === 'subagents_update') {
    // Why: a model switch or a child ending happens between lead events, so it rides on the
    // pane's last visible row instead of inventing a state. Before any row exists there is
    // nothing to describe, and a providerSessionOnly placeholder is a hidden resume record.
    const previous = state.lastStatusByPaneKey.get(paneKey)
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
  const isOmpPlanReview = agentType === 'omp' && eventName === 'plan_review_requested'
  const isOmpPlanReviewEnd = agentType === 'omp' && eventName === 'plan_review_resolved'
  const isPiUiPrompt =
    agentType === 'pi' && (eventName === 'ui_prompt_start' || hookPayload.ui_prompt_active === true)
  const isPiUiPromptEnd = agentType === 'pi' && eventName === 'ui_prompt_end'

  let stateName =
    isPiCompatibleAsk || isOmpApprovalRequest || isOmpPlanReview
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
  } else if (isPiUiPromptEnd || isOmpPlanReviewEnd) {
    stateName = hookPayload.is_idle === true ? 'done' : 'working'
  }

  if (
    !stateName ||
    (stateName === 'working' && holdsOmpApproval(state, agentType, eventName, paneKey)) ||
    (eventName === 'agent_end' && holdsOmpPlanReview(state, agentType, hookPayload, paneKey))
  ) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields(agentType, eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent(agentType, eventName) }
  )

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
    // Why: the extension ends a run whose session was replaced; that is not a completed turn.
    ...(eventName === 'agent_end' && hookPayload.session_boundary === true
      ? { sessionBoundary: true }
      : {})
  })
}

const OMP_APPROVAL_RELEASE_EVENTS: ReadonlySet<unknown> = new Set([
  'tool_approval_resolved',
  'plan_review_resolved',
  'before_agent_start',
  'agent_start'
])

/**
 * Whether an OMP approval wait must survive this working event. omp posts \`tool_execution_start\`
 * right after \`tool_approval_requested\`, while its Approve/Deny select still holds the human, so
 * only the resolution (or a new turn) ends the wait. An \`ask\` row is its own tool's wait, which
 * \`tool_execution_end\` ends.
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

/**
 * Whether an open OMP plan review must survive this completion. A turn cannot end under the
 * overlay, but the extension posts \`agent_end\` when the last async child of an earlier turn
 * finishes, and only the review's own resolution (or a new session) ends this wait.
 */
function holdsOmpPlanReview(
  state: HookListenerState,
  agentType: 'pi' | 'omp' | 'prime-agent',
  hookPayload: Record<string, unknown>,
  paneKey: string
): boolean {
  if (agentType !== 'omp' || hookPayload.session_boundary === true) {
    return false
  }
  const previous = state.lastStatusByPaneKey.get(paneKey)?.payload
  return (
    previous?.state === 'blocked' && parseOmpPlanReviewPrompt(previous.interactivePrompt) !== null
  )
}
`
const dependencies: Record<string, unknown> = {
  '../../agent-status-types': statusTypes,
  '../../agent-question-answered-intent': questionTools,
  '../listener-state': listenerState,
  '../prompt-fields': promptFields,
  '../provider-event-routing': eventRouting,
  '../tool-input-preview': toolPreview,
  '../../omp-plan-review-prompt': planReview
}
const oldExports: { normalizePiCompatibleEvent?: typeof normalizePiCompatibleEvent } = {}
runInNewContext(
  ts.transpileModule(oldReceiverSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } })
    .outputText,
  {
    exports: oldExports,
    require: (name: string) => {
      if (!(name in dependencies)) {
        throw new Error(`Unexpected frozen receiver dependency: ${name}`)
      }
      return dependencies[name]
    }
  }
)
const oldFold = oldExports.normalizePiCompatibleEvent
if (!oldFold) {
  throw new Error('Missing frozen raw receiver')
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('keeps new-source lead provenance/content and surviving-request relays on an old raw receiver', async () => {
  vi.useFakeTimers()
  const current = listenerState.createHookListenerState()
  const old = listenerState.createHookListenerState()
  let accepted: ReturnType<typeof normalizeHookPayload> | undefined
  let oldPayload: ReturnType<typeof oldFold> | undefined
  const paneKey = makePaneKey('mixed-receiver', '44444444-4444-4444-8444-444444444444')
  const h = createAgentStatusExtensionHarness({
    kind: 'pi',
    argv: ['node', '/usr/bin/pi'],
    existsSync: () => true,
    env: {
      ORCA_PANE_KEY: paneKey,
      ORCA_TAB_ID: 'mixed-receiver',
      ORCA_AGENT_HOOK_ENV: 'production',
      ORCA_AGENT_HOOK_VERSION: '1'
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      accepted = normalizeHookPayload(current, 'pi', body, 'production')
      oldPayload = oldFold(
        old,
        'pi',
        body.payload.hook_event_name,
        body.payload.prompt ?? '',
        paneKey,
        body.payload
      )
      if (accepted) {
        expect(
          cacheRelayLegacyAgentStatus(current, accepted, 16, (key) =>
            listenerState.clearPaneCacheState(current, key)
          )
        ).toBe(true)
      }
      if (accepted && oldPayload) {
        expect(
          cacheRelayLegacyAgentStatus(old, { ...accepted, payload: oldPayload }, 16, (key) =>
            listenerState.clearPaneCacheState(old, key)
          )
        ).toBe(true)
      }
      return { ok: true }
    }
  })
  const ctx = (id: string) => ({
    sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` },
    isIdle: () => true
  })
  const root = ctx('lead')
  await h.callHook('session_start', {}, root)
  await h.callHook('agent_start', {}, root)
  const child = h.registerSession(),
    childCtx = ctx('child')
  await child.callHook('session_start', {}, childCtx)
  const input = { questions: [{ question: 'A source-owned question?', options: ['yes', 'no'] }] }
  await child.callHook('tool_call', { toolName: 'ask_user_question', input }, childCtx)
  await vi.advanceTimersByTimeAsync(0)
  expect(oldPayload?.state).toBe('blocked')
  await h.callHook('before_agent_start', { prompt: 'A real prompt' }, root)
  await vi.advanceTimersByTimeAsync(0)
  expect(accepted).toMatchObject({
    hookEventName: 'before_agent_start',
    hasExplicitPrompt: true,
    providerSession: { id: 'lead' }
  })
  expect(oldPayload).toMatchObject({ state: 'working', prompt: 'A real prompt' })
  expect(accepted?.payload.state).toBe('blocked')
  await h.callHook('message_end', { message: { role: 'assistant', content: 'A real reply' } }, root)
  await vi.advanceTimersByTimeAsync(0)
  expect(oldPayload).toMatchObject({ state: 'working', lastAssistantMessage: 'A real reply' })
  expect(accepted?.payload).toMatchObject({
    state: 'blocked',
    lastAssistantMessage: 'A real reply',
    interactivePrompt: JSON.stringify(input)
  })
  await h.callHook('agent_end', {}, root)
  await vi.advanceTimersByTimeAsync(0)
  expect(oldPayload?.state).toBe('done')
  expect(accepted?.payload.state).toBe('blocked')
  const other = h.registerSession(),
    otherCtx = ctx('other')
  await other.callHook('session_start', {}, otherCtx)
  await other.callHook(
    'tool_call',
    { toolName: 'ask_user_question', input: { questions: [{ question: 'Other?' }] } },
    otherCtx
  )
  await other.callHook('tool_execution_end', { toolName: 'ask_user_question' }, otherCtx)
  await vi.advanceTimersByTimeAsync(0)
  expect(accepted?.hookEventName).toBe('tool_call')
  expect(oldPayload).toMatchObject({ state: 'blocked', interactivePrompt: JSON.stringify(input) })
  await child.callHook('tool_execution_end', { toolName: 'ask_user_question' }, childCtx)
  await vi.advanceTimersByTimeAsync(0)
  expect(oldPayload?.interactivePrompt).toBeUndefined()
  expect(accepted?.payload).toMatchObject({ state: 'done' })
  expect(accepted?.payload.toolInput).toBeUndefined()
})

it('keeps an admitted old-source approval through work, releasing it on the original new turn', () => {
  const state = listenerState.createHookListenerState()
  const paneKey = makePaneKey('legacy-source', '44444444-4444-4444-8444-444444444444')
  const send = (payload: Record<string, unknown>) => {
    const event = normalizeHookPayload(state, 'omp', { paneKey, payload }, 'production')
    if (event) {
      expect(
        cacheRelayLegacyAgentStatus(state, event, 16, (key) =>
          listenerState.clearPaneCacheState(state, key)
        )
      ).toBe(true)
    }
    return event
  }
  expect(
    send({ hook_event_name: 'tool_approval_requested', tool_name: 'bash', approval_mode: 'yolo' })
      ?.payload.state
  ).toBe('blocked')
  expect(send({ hook_event_name: 'tool_execution_start', tool_name: 'bash' })).toBeNull()
  expect(send({ hook_event_name: 'before_agent_start', prompt: 'User moves on' })).toMatchObject({
    hookEventName: 'before_agent_start',
    hasExplicitPrompt: true,
    payload: { state: 'working', prompt: 'User moves on' }
  })
})
