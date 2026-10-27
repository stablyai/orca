import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  clearPaneTurnCacheState,
  createHookListenerState,
  movePaneCacheState,
  paneHasStateClaims,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { PANE_KEY } from './agent-hook-listener-test-harness'

function ingest(state: HookListenerState, payload: Record<string, unknown>) {
  return normalizeHookPayload(
    state,
    'jcode',
    { paneKey: PANE_KEY, payload: { hook_event_name: payload.event, ...payload } },
    'production'
  )
}

function cacheSnapshot(state: HookListenerState) {
  return structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
}

describe('shared agent-hook-listener: jcode', () => {
  let state: HookListenerState
  let jcodeHome: string

  beforeEach(() => {
    jcodeHome = mkdtempSync(join(tmpdir(), 'orca-jcode-hooks-'))
    vi.stubEnv('JCODE_HOME', jcodeHome)
    state = createHookListenerState()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(jcodeHome, { recursive: true, force: true })
  })

  it('maps turn_start to working before any tool has run', () => {
    const event = ingest(state, {
      event: 'turn_start',
      session_id: 'session_jc_1',
      model: 'claude-haiku-4-5',
      source: 'chat'
    })
    expect(event?.payload).toMatchObject({
      agentType: 'jcode',
      state: 'working',
      model: 'claude-haiku-4-5'
    })
    expect(event?.payload?.toolName).toBeUndefined()
  })

  it('reports the live tool from pre_tool, before the tool has finished', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_1' })
    const event = ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_1',
      tool_name: 'read',
      tool_input: '{"file_path":"sample.txt","intent":"Read sample.txt to get its contents"}'
    })
    expect(event?.payload).toMatchObject({
      agentType: 'jcode',
      state: 'working',
      toolName: 'read',
      toolInput: 'sample.txt'
    })
  })

  it('falls back to the tool intent when no tool-specific key matches', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_1' })
    const event = ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_1',
      tool_name: 'swarm',
      tool_input: '{"action":"status","intent":"Check on the workers"}'
    })
    expect(event?.payload).toMatchObject({ toolName: 'swarm', toolInput: 'Check on the workers' })
  })

  it('keeps the pre_tool input visible when post_tool reports completion', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_1' })
    ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_1',
      tool_name: 'bash',
      tool_input: '{"command":"pnpm test","intent":"Run the suite"}'
    })
    const event = ingest(state, {
      event: 'post_tool',
      session_id: 'session_jc_1',
      tool_name: 'bash',
      status: 'ok',
      duration_ms: '9',
      output_bytes: '137'
    })
    expect(event?.payload).toMatchObject({
      state: 'working',
      toolName: 'bash',
      toolInput: 'pnpm test'
    })
  })

  it('maps a pending request_permission to waiting with the full question', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_2' })
    const event = ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_2',
      tool_name: 'request_permission',
      tool_input: '{"action":"delete the staging bucket","reason":"Why this needs approval"}'
    })
    expect(event?.payload).toMatchObject({
      agentType: 'jcode',
      state: 'waiting',
      toolName: 'request_permission'
    })
    expect(JSON.parse(event?.payload?.interactivePrompt ?? '{}')).toMatchObject({
      action: 'delete the staging bucket',
      reason: 'Why this needs approval'
    })
  })

  it('does not re-open a question on post_tool, which fires after the answer', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_2' })
    const pending = ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_2',
      tool_name: 'request_permission',
      tool_input: '{"action":"delete the staging bucket","reason":"Why this needs approval"}'
    })
    expect(pending?.payload.state).toBe('waiting')
    expect(pending?.payload.interactivePrompt).toBeDefined()
    const event = ingest(state, {
      event: 'post_tool',
      session_id: 'session_jc_2',
      tool_name: 'request_permission',
      status: 'ok'
    })
    expect(event?.payload).toMatchObject({ state: 'working' })
    expect(event?.payload.interactivePrompt).toBeUndefined()
  })

  it('leaves unrelated tool names working even when they read like a question', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_2' })
    const event = ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_2',
      tool_name: 'conversation_search',
      tool_input: '{"query":"what did we confirm about the ask flow"}'
    })
    expect(event?.payload).toMatchObject({ state: 'working', toolName: 'conversation_search' })
  })

  it('maps turn_end to done with the last assistant text', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_3' })
    const event = ingest(state, {
      event: 'turn_end',
      session_id: 'session_jc_3',
      status: 'ok',
      duration_ms: '6868',
      model: 'claude-haiku-4-5',
      last_assistant_text: 'Done.'
    })
    expect(event?.payload).toMatchObject({
      agentType: 'jcode',
      state: 'done',
      lastAssistantMessage: 'Done.'
    })
  })

  it('surfaces the turn error instead of a stale reply when a turn fails', () => {
    const previous = ingest(state, {
      event: 'turn_end',
      session_id: 'session_jc_3',
      status: 'ok',
      last_assistant_text: 'Stale reply.'
    })
    expect(previous?.payload.lastAssistantMessage).toBe('Stale reply.')
    ingest(state, { event: 'turn_start', session_id: 'session_jc_3' })
    const event = ingest(state, {
      event: 'turn_end',
      session_id: 'session_jc_3',
      status: 'error',
      model: 'claude-haiku-4-5',
      error: 'Anthropic API error (503 Service Unavailable)'
    })
    expect(event?.payload).toMatchObject({
      state: 'done',
      lastAssistantMessage: 'Anthropic API error (503 Service Unavailable)'
    })
  })

  it('keeps the finished turn detail a completion notification needs', () => {
    // Done banners require reply/tool detail; retain the last tool when the turn ends without prose.
    ingest(state, {
      event: 'turn_start',
      session_id: 'session_jc_6',
      model: 'claude-haiku-4-5',
      source: 'chat'
    })
    ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_6',
      tool_name: 'write',
      tool_input: '{"file_path":"SUMMARY.md","content":"# Summary"}'
    })
    const event = ingest(state, {
      event: 'turn_end',
      session_id: 'session_jc_6',
      status: 'ok',
      duration_ms: '18000'
    })
    expect(event?.payload).toMatchObject({ state: 'done', toolName: 'write' })
  })

  it('clears the previous turn tool when a new turn starts', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_4' })
    const previous = ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_4',
      tool_name: 'bash',
      tool_input: '{"command":"pnpm lint"}'
    })
    expect(previous?.payload).toMatchObject({ toolName: 'bash', toolInput: 'pnpm lint' })
    const event = ingest(state, {
      event: 'turn_start',
      session_id: 'session_jc_4',
      model: 'claude-haiku-4-5',
      source: 'chat'
    })
    expect(event?.payload?.toolName).toBeUndefined()
    expect(event?.payload?.toolInput).toBeUndefined()
  })

  it('treats session_start as identity-only (no status row)', () => {
    const event = ingest(state, {
      event: 'session_start',
      session_id: 'session_jc_5',
      model: 'claude-haiku-4-5',
      source: 'create'
    })
    expect(event?.payload).toMatchObject({ agentType: 'jcode', state: 'done' })
    expect(event?.providerSession).toEqual({ key: 'session_id', id: 'session_jc_5' })
    expect(event?.providerSessionOnly).toBe(true)
  })

  it('reads the lifecycle point from jcode\u2019s own `event` key', () => {
    // Managed transport posts JCODE_HOOK_PAYLOAD verbatim; accept its event field without form restatement.
    const event = normalizeHookPayload(
      state,
      'jcode',
      {
        paneKey: PANE_KEY,
        payload: { event: 'turn_start', session_id: 'session_jc_7', model: 'claude-haiku-4-5' }
      },
      'production'
    )
    expect(event?.payload).toMatchObject({ agentType: 'jcode', state: 'working' })
  })

  it('does not count a direct jcode prompt without journal evidence as explicit', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_8' })
    // Hook prompt fields lack journal backing and must not imply explicit submission.
    const event = ingest(state, {
      event: 'post_tool',
      session_id: 'session_jc_8',
      tool_name: 'read',
      prompt: 'fix the bug'
    })
    expect(event?.payload).toMatchObject({ agentType: 'jcode', state: 'working' })
    expect(event?.hasExplicitPrompt).toBeFalsy()
  })

  it.each(['pre_tool', 'post_tool'])('drops orphan %s before touching caches', (event) => {
    const baseline = cacheSnapshot(state)
    expect(
      ingest(state, {
        event,
        session_id: 'orphan',
        prompt: 'wrong',
        model: 'wrong',
        tool_name: 'bash',
        tool_input: '{"command":"sleep 60"}'
      })
    ).toBeNull()
    expect(cacheSnapshot(state)).toEqual(baseline)
  })

  it('admits permission answers only during their matching turn', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_2' })
    const permission = {
      event: 'pre_tool',
      session_id: 'session_jc_2',
      tool_name: 'request_permission',
      tool_input: '{"action":"delete the staging bucket"}'
    }
    expect(ingest(state, permission)?.payload.state).toBe('waiting')
    expect(ingest(state, { ...permission, event: 'post_tool' })?.payload.state).toBe('working')
    ingest(state, { event: 'turn_end', session_id: 'session_jc_2' })
    expect(ingest(state, { ...permission, event: 'post_tool' })).toBeNull()
  })

  it('moves admission with the pane and clears it on every teardown path', () => {
    ingest(state, { event: 'turn_start', session_id: 'session_jc_1' })
    expect(paneHasStateClaims(state, PANE_KEY)).toBe(true)
    movePaneCacheState(state, PANE_KEY, 'tab-2:22222222-2222-4222-8222-222222222222')
    expect(state.jcodeTurnByPaneKey.has(PANE_KEY)).toBe(false)
    expect(paneHasStateClaims(state, PANE_KEY)).toBe(false)
    expect(paneHasStateClaims(state, 'tab-2:22222222-2222-4222-8222-222222222222')).toBe(true)
    expect(ingest(state, { event: 'post_tool', session_id: 'session_jc_1' })).toBeNull()
    expect(
      normalizeHookPayload(
        state,
        'jcode',
        {
          paneKey: 'tab-2:22222222-2222-4222-8222-222222222222',
          payload: {
            event: 'post_tool',
            session_id: 'session_jc_1',
            tool_name: 'read'
          }
        },
        'production'
      )?.payload.state
    ).toBe('working')
    clearPaneCacheState(state, 'tab-2:22222222-2222-4222-8222-222222222222')
    expect(state.jcodeTurnByPaneKey.size).toBe(0)
    expect(paneHasStateClaims(state, 'tab-2:22222222-2222-4222-8222-222222222222')).toBe(false)
    ingest(state, { event: 'turn_start', session_id: 'session_jc_1' })
    clearPaneTurnCacheState(state, PANE_KEY)
    expect(state.jcodeTurnByPaneKey.size).toBe(0)
    ingest(state, { event: 'turn_start', session_id: 'session_jc_1' })
    clearAllListenerCaches(state)
    expect(state.jcodeTurnByPaneKey.size).toBe(0)
    expect(ingest(state, { event: 'post_tool', session_id: 'session_jc_1' })).toBeNull()
  })

  it('drops turn_start without session_id before changing admission or caches', () => {
    // Jcode 0.99.0 always sends session_id; a fenced turn requires that owner.
    const baseline = cacheSnapshot(state)
    expect(ingest(state, { event: 'turn_start', model: 'claude-opus-5-5' })).toBeNull()
    expect(cacheSnapshot(state)).toEqual(baseline)
  })

  it('keeps revisions unique through copied listener views', () => {
    ingest({ ...state }, { event: 'turn_start', session_id: 'session_jc_1' })
    const first = state.jcodeTurnByPaneKey.get(PANE_KEY)?.revision
    clearPaneCacheState(state, PANE_KEY)
    ingest({ ...state }, { event: 'turn_start', session_id: 'session_jc_1' })
    expect(state.jcodeTurnByPaneKey.get(PANE_KEY)?.revision).toBeGreaterThan(first ?? 0)
  })
})
