import { describe, expect, it } from 'vitest'

import {
  createHookListenerState,
  normalizeHookPayload,
  resolveCachedClaudeCompactOwnership,
  type AgentHookEventPayload,
  type HookListenerState
} from './agent-hook-listener'
import type { AgentHookSource } from './agent-hook-relay'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('manual-compact-prompt', LEAF_ID)
const PROMPT_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const PROMPT_ID_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'

function accept(
  state: HookListenerState,
  source: AgentHookSource,
  payload: Record<string, unknown>,
  paneKey = PANE_KEY
): AgentHookEventPayload | null {
  const event = normalizeHookPayload(state, source, { paneKey, payload }, 'production')
  if (event) {
    state.lastStatusByPaneKey.set(
      paneKey,
      resolveCachedClaudeCompactOwnership(state.lastStatusByPaneKey.get(paneKey), event)
    )
  }
  return event
}

function beginManualCompact(
  state: HookListenerState,
  promptId: string,
  sessionId: string | undefined = 'session-a'
): AgentHookEventPayload | null {
  const identity = {
    prompt_id: promptId,
    ...(sessionId ? { session_id: sessionId } : {})
  }
  accept(state, 'claude', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '/compact',
    ...identity
  })
  return accept(state, 'claude', {
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    ...identity
  })
}

function finishManualCompact(
  state: HookListenerState,
  promptId: string | undefined,
  sessionId: string | null = 'session-a'
): AgentHookEventPayload | null {
  return accept(state, 'claude', {
    hook_event_name: 'PostCompact',
    trigger: 'manual',
    ...(promptId ? { prompt_id: promptId } : {}),
    ...(sessionId ? { session_id: sessionId } : {})
  })
}

describe('manual compact prompt identity', () => {
  it('settles only the matching Claude manual compact', () => {
    const state = createHookListenerState()

    const pre = beginManualCompact(state, PROMPT_ID_1)
    const post = finishManualCompact(state, PROMPT_ID_1)

    expect(pre).toMatchObject({
      source: 'claude',
      providerPromptId: PROMPT_ID_1,
      compactTrigger: 'manual',
      hookEventName: 'PreCompact',
      payload: { state: 'working', prompt: '/compact', agentType: 'claude' }
    })
    expect(post).toMatchObject({
      source: 'claude',
      providerPromptId: PROMPT_ID_1,
      compactTrigger: 'manual',
      hookEventName: 'PostCompact',
      payload: { state: 'done', prompt: '/compact', agentType: 'claude' }
    })
  })

  it('rejects stale, duplicate, and session-mismatched completion', () => {
    const state = createHookListenerState()
    beginManualCompact(state, PROMPT_ID_1)
    expect(finishManualCompact(state, PROMPT_ID_1, 'session-b')).toBeNull()
    expect(finishManualCompact(state, PROMPT_ID_1)).not.toBeNull()
    expect(finishManualCompact(state, PROMPT_ID_1)).toBeNull()

    beginManualCompact(state, PROMPT_ID_2)
    expect(finishManualCompact(state, PROMPT_ID_1)).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toMatchObject({
      providerPromptId: PROMPT_ID_2,
      hookEventName: 'PreCompact',
      payload: { state: 'working' }
    })
  })

  it('does not let stale compact events replace intervening provider work', () => {
    const state = createHookListenerState()
    beginManualCompact(state, PROMPT_ID_1)
    expect(finishManualCompact(state, PROMPT_ID_1)).not.toBeNull()
    accept(state, 'codex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'new Codex work',
      session_id: 'codex-session'
    })

    expect(
      accept(state, 'claude', {
        hook_event_name: 'PreCompact',
        trigger: 'manual',
        prompt_id: PROMPT_ID_1,
        session_id: 'session-a'
      })
    ).toBeNull()
    expect(finishManualCompact(state, PROMPT_ID_1)).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toMatchObject({
      source: 'codex',
      payload: { state: 'working', prompt: 'new Codex work', agentType: 'codex' }
    })
  })

  it('fails closed without exact prompt identity and session presence', () => {
    const state = createHookListenerState()
    expect(beginManualCompact(state, 'not-a-uuid')).toBeNull()
    expect(beginManualCompact(state, PROMPT_ID_1)).not.toBeNull()
    expect(finishManualCompact(state, undefined)).toBeNull()
    expect(finishManualCompact(state, PROMPT_ID_1, null)).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.hookEventName).toBe('PreCompact')
  })

  it('keeps automatic compact working and ignores unproven Kimi events', () => {
    const state = createHookListenerState()
    const current = accept(state, 'claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue the task',
      prompt_id: PROMPT_ID_1,
      session_id: 'session-a'
    })
    const automaticPre = accept(state, 'claude', {
      hook_event_name: 'PreCompact',
      trigger: 'auto',
      prompt_id: PROMPT_ID_1,
      session_id: 'session-a'
    })
    const automaticPost = accept(state, 'claude', {
      hook_event_name: 'PostCompact',
      trigger: 'auto',
      prompt_id: PROMPT_ID_1,
      session_id: 'session-a'
    })
    const kimiPre = accept(state, 'kimi', {
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      prompt_id: PROMPT_ID_1,
      session_id: 'session-a'
    })
    const kimiPost = accept(state, 'kimi', {
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      prompt_id: PROMPT_ID_1,
      session_id: 'session-a'
    })

    expect(automaticPre).toMatchObject({
      compactTrigger: 'auto',
      hookEventName: 'PreCompact',
      payload: { state: 'working' }
    })
    expect(automaticPost).toMatchObject({
      compactTrigger: 'auto',
      hookEventName: 'PostCompact',
      payload: { state: 'working' }
    })
    expect(kimiPre).toBeNull()
    expect(kimiPost).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toMatchObject({
      hookEventName: 'PostCompact',
      compactTrigger: undefined,
      payload: { state: 'working', prompt: current?.payload.prompt }
    })
  })

  it('does not let stale manual completion retire a newer automatic compact', () => {
    const state = createHookListenerState()
    beginManualCompact(state, PROMPT_ID_1)
    expect(
      accept(state, 'claude', {
        hook_event_name: 'PreCompact',
        trigger: 'auto',
        prompt_id: PROMPT_ID_1,
        session_id: 'session-a'
      })
    ).toMatchObject({ compactTrigger: 'auto', payload: { state: 'working' } })

    expect(finishManualCompact(state, PROMPT_ID_1)).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toMatchObject({
      compactTrigger: 'auto',
      hookEventName: 'PreCompact',
      payload: { state: 'working' }
    })
  })

  it('does not allocate ownership for unaccepted untrusted pane keys', () => {
    const state = createHookListenerState()
    for (let index = 0; index < 4_097; index += 1) {
      normalizeHookPayload(
        state,
        'claude',
        {
          paneKey: makePaneKey(`untrusted-${index}`, LEAF_ID),
          payload: {
            hook_event_name: 'PreCompact',
            trigger: 'manual',
            prompt_id: PROMPT_ID_1,
            session_id: 'session-a'
          }
        },
        'production'
      )
    }

    expect(state.lastStatusByPaneKey.size).toBe(0)
    expect(state.lastPromptByPaneKey.size).toBe(0)
  })
})
