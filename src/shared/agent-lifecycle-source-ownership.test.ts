import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHookListenerState,
  markClaudeLeadTurnInterrupted,
  normalizeHookPayload,
  seedAgentSubagentLifecycleFromSnapshots,
  type HookListenerState
} from './agent-hook-listener'
import type { AgentHookSource } from './agent-hook-relay'
import { AGENT_STATUS_STALE_AFTER_MS, type AgentSubagentSnapshot } from './agent-status-types'
import { makePaneKey } from './stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

describe('agent lifecycle source ownership', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const providerEvent = (
    source: AgentHookSource,
    payload: Record<string, unknown>
  ): ReturnType<typeof normalizeHookPayload> =>
    normalizeHookPayload(state, source, { paneKey: PANE_KEY, payload }, 'production')

  const cacheStatus = (
    agentType: 'claude' | 'codex',
    status: 'working' | 'done',
    receivedAt: number,
    subagents?: AgentSubagentSnapshot[]
  ): void => {
    state.lastStatusByPaneKey.set(
      PANE_KEY,
      Object.assign(
        {
          paneKey: PANE_KEY,
          connectionId: null,
          payload: {
            state: status,
            prompt: 'cached turn',
            agentType,
            ...(subagents ? { subagents } : {})
          }
        },
        { receivedAt }
      )
    )
  }

  it('keeps active nested providers out of both lifecycle stores', () => {
    providerEvent('codex', { hook_event_name: 'UserPromptSubmit', prompt: 'parent codex' })
    providerEvent('codex', {
      hook_event_name: 'SubagentStart',
      agent_id: 'parent-reviewer',
      agent_type: 'reviewer'
    })

    expect(providerEvent('copilot', { hook_event_name: 'sessionStart' })?.payload.state).toBe(
      'working'
    )
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.source).toBe('codex')
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.roster.has('parent-reviewer')).toBe(
      true
    )

    const nestedClaude = providerEvent('claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'nested claude work'
    })
    expect(nestedClaude?.payload).toMatchObject({
      state: 'working',
      prompt: 'nested claude work',
      agentType: 'codex',
      subagents: [expect.objectContaining({ id: 'parent-reviewer' })]
    })
    expect(state.claudeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)
    expect(state.claudeLeadStateByPaneKey.has(PANE_KEY)).toBe(false)

    expect(
      providerEvent('claude', {
        hook_event_name: 'SubagentStart',
        agent_id: 'nested-claude-child'
      })
    ).toBeNull()
    expect(state.claudeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)

    const nestedStop = providerEvent('claude', {
      hook_event_name: 'Stop',
      last_assistant_message: 'nested child finished'
    })
    expect(nestedStop?.payload).toMatchObject({
      state: 'working',
      agentType: 'codex',
      subagents: [expect.objectContaining({ id: 'parent-reviewer' })]
    })
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)?.source).toBe('codex')

    const parentStop = providerEvent('codex', { hook_event_name: 'Stop' })
    expect(parentStop?.payload).toMatchObject({ state: 'working', leadState: 'done' })
    expect(parentStop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'parent-reviewer' })
    ])
  })

  it('switches stale Claude ownership without accepting late Claude children', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    providerEvent('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'old claude' })
    providerEvent('claude', {
      hook_event_name: 'SubagentStart',
      agent_id: 'old-claude-child'
    })
    expect(providerEvent('claude', { hook_event_name: 'Stop' })?.payload.state).toBe('working')

    vi.setSystemTime(1_000 + AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(providerEvent('codex', { hook_event_name: 'SessionStart' })?.payload.state).toBe(
      'working'
    )
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)?.source).toBe('codex')
    expect(state.claudeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)

    providerEvent('codex', { hook_event_name: 'SubagentStart', agent_id: 'current-codex-child' })
    providerEvent('codex', { hook_event_name: 'Stop' })
    expect(
      providerEvent('claude', {
        hook_event_name: 'SubagentStop',
        agent_id: 'old-claude-child'
      })
    ).toBeNull()
    expect(
      state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.roster.has('current-codex-child')
    ).toBe(true)

    expect(
      providerEvent('codex', {
        hook_event_name: 'SubagentStop',
        agent_id: 'current-codex-child'
      })?.payload.state
    ).toBe('done')
    expect(
      providerEvent('claude', {
        hook_event_name: 'SubagentStart',
        agent_id: 'post-done-late-claude-child'
      })
    ).toBeNull()
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)).toMatchObject({
      source: 'codex',
      state: 'done'
    })

    expect(
      providerEvent('claude', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'real claude replacement'
      })?.payload.state
    ).toBe('working')
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)?.source).toBe('claude')
  })

  it('switches stale generic ownership without accepting late generic children', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    providerEvent('codex', { hook_event_name: 'UserPromptSubmit', prompt: 'old codex' })
    providerEvent('codex', { hook_event_name: 'SubagentStart', agent_id: 'old-codex-child' })
    expect(providerEvent('codex', { hook_event_name: 'Stop' })?.payload.state).toBe('working')

    vi.setSystemTime(2_000 + AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(
      providerEvent('claude', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'current claude'
      })?.payload.state
    ).toBe('working')
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)?.source).toBe('claude')
    expect(state.agentSubagentLifecycleByPaneKey.has(PANE_KEY)).toBe(false)

    providerEvent('claude', {
      hook_event_name: 'SubagentStart',
      agent_id: 'current-claude-child'
    })
    providerEvent('claude', { hook_event_name: 'Stop' })
    expect(
      providerEvent('codex', { hook_event_name: 'SubagentStop', agent_id: 'old-codex-child' })
    ).toBeNull()
    expect(state.claudeSubagentRosterByPaneKey.get(PANE_KEY)?.has('current-claude-child')).toBe(
      true
    )

    expect(
      providerEvent('claude', {
        hook_event_name: 'SubagentStop',
        agent_id: 'current-claude-child'
      })?.payload.state
    ).toBe('done')
    expect(
      providerEvent('codex', {
        hook_event_name: 'SubagentStart',
        agent_id: 'post-done-late-codex-child'
      })
    ).toBeNull()
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)).toMatchObject({
      source: 'claude',
      state: 'done'
    })

    expect(providerEvent('codex', { hook_event_name: 'SessionStart' })?.payload.state).toBe(
      'working'
    )
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)?.source).toBe('codex')
    expect(state.claudeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)
  })

  it('hydrates lifecycle ownership with the persisted provider timestamp', () => {
    const snapshots = [{ id: 'persisted-child', state: 'working' as const, startedAt: 123 }]
    cacheStatus('codex', 'working', 1_000, snapshots)
    seedAgentSubagentLifecycleFromSnapshots(state, PANE_KEY, 'codex', snapshots, {
      leadState: 'done'
    })

    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)).toEqual({
      source: 'codex',
      state: 'working',
      updatedAt: 1_000
    })

    vi.useFakeTimers()
    vi.setSystemTime(1_000 + AGENT_STATUS_STALE_AFTER_MS + 1)
    providerEvent('claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'post-restart replacement'
    })
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)?.source).toBe('claude')
    expect(state.agentSubagentLifecycleByPaneKey.has(PANE_KEY)).toBe(false)
  })

  it('derives an active owner from persisted status before considering child bootstrap', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    cacheStatus('codex', 'working', 1_000)

    expect(
      providerEvent('claude', {
        hook_event_name: 'SubagentStart',
        agent_id: 'late-claude-child'
      })
    ).toBeNull()
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)).toEqual({
      source: 'codex',
      state: 'working',
      updatedAt: 1_000
    })
    expect(state.claudeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)
  })

  it('lets a real provider claim immediately after an inferred Claude interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000)
    providerEvent('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'interrupt me' })
    markClaudeLeadTurnInterrupted(state, PANE_KEY)
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)).toEqual({
      source: 'claude',
      state: 'done',
      updatedAt: 3_000
    })

    expect(providerEvent('codex', { hook_event_name: 'SessionStart' })?.payload.state).toBe(
      'working'
    )
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)?.source).toBe('codex')
    expect(state.claudeLeadStateByPaneKey.has(PANE_KEY)).toBe(false)
  })

  it('reconciles a newer matching done status before resolving provider ownership', () => {
    vi.useFakeTimers()
    vi.setSystemTime(4_000)
    providerEvent('codex', { hook_event_name: 'UserPromptSubmit', prompt: 'generic turn' })
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)?.state).toBe('working')

    cacheStatus('codex', 'done', 4_100)
    vi.setSystemTime(4_100)
    expect(
      providerEvent('claude', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'replacement after inferred done'
      })?.payload.state
    ).toBe('working')
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)).toMatchObject({
      source: 'claude',
      state: 'working'
    })
    expect(state.agentSubagentLifecycleByPaneKey.has(PANE_KEY)).toBe(false)
  })
})
