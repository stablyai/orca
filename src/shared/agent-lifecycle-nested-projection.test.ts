import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHookListenerState,
  normalizeHookPayload,
  seedAgentSubagentLifecycleFromSnapshots,
  type HookListenerState
} from './agent-hook-listener'
import type { AgentHookSource } from './agent-hook-relay'
import { makePaneKey } from './stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

describe('nested agent lifecycle projection', () => {
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

  const productionEvent = (
    source: AgentHookSource,
    payload: Record<string, unknown>
  ): ReturnType<typeof normalizeHookPayload> => {
    const event = providerEvent(source, payload)
    if (event) {
      state.lastStatusByPaneKey.set(PANE_KEY, Object.assign(event, { receivedAt: Date.now() }))
    }
    return event
  }

  it('projects nested working, waiting, and done over the owner lifecycle presentation', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    productionEvent('claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'owner review',
      session_id: 'owner-session'
    })
    productionEvent('claude', {
      hook_event_name: 'SubagentStart',
      agent_id: 'owner-reviewer',
      agent_type: 'reviewer',
      session_id: 'owner-session'
    })
    const ownerStatus = productionEvent('claude', {
      hook_event_name: 'Stop',
      is_interrupt: true,
      agentId: 'owner-lead-id',
      agentType: 'owner-lead-type',
      toolUseId: 'owner-tool-use',
      session_id: 'owner-session'
    })
    expect(ownerStatus?.payload).toMatchObject({
      state: 'working',
      agentType: 'claude',
      leadState: 'done',
      leadInterrupted: true,
      subagents: [expect.objectContaining({ id: 'owner-reviewer' })]
    })
    const ownerRecord = state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)

    const nestedWorking = productionEvent('codex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'nested analysis',
      session_id: 'nested-session'
    })
    expect(nestedWorking).toMatchObject({
      providerSession: { id: 'owner-session' },
      toolUseId: 'owner-tool-use',
      toolAgentId: 'owner-lead-id',
      toolAgentType: 'owner-lead-type',
      payload: {
        state: 'working',
        lifecycleOwnerState: 'working',
        prompt: 'nested analysis',
        agentType: 'claude',
        leadState: 'done',
        leadInterrupted: true,
        subagents: [expect.objectContaining({ id: 'owner-reviewer' })]
      }
    })

    vi.setSystemTime(5_001)
    const nestedWaiting = productionEvent('codex', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      toolUseId: 'nested-tool-use',
      agentType: 'nested-agent-type',
      session_id: 'nested-session'
    })
    expect(nestedWaiting?.payload).toMatchObject({
      state: 'waiting',
      lifecycleOwnerState: 'working',
      agentType: 'claude',
      leadState: 'done',
      leadInterrupted: true,
      toolName: 'Bash',
      toolInput: 'pnpm test',
      subagents: [expect.objectContaining({ id: 'owner-reviewer' })]
    })
    expect(nestedWaiting).toMatchObject({
      providerSession: { id: 'owner-session' },
      toolUseId: 'owner-tool-use',
      toolAgentId: 'owner-lead-id',
      toolAgentType: 'owner-lead-type'
    })

    vi.setSystemTime(5_002)
    const nestedResumed = productionEvent('codex', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      session_id: 'nested-session'
    })
    expect(nestedResumed?.payload).toMatchObject({
      state: 'working',
      lifecycleOwnerState: 'working',
      agentType: 'claude',
      leadState: 'done',
      leadInterrupted: true,
      subagents: [expect.objectContaining({ id: 'owner-reviewer' })]
    })

    vi.setSystemTime(5_003)
    const nestedDone = productionEvent('codex', {
      hook_event_name: 'Stop',
      last_assistant_message: 'nested complete',
      session_id: 'nested-session'
    })
    expect(nestedDone?.payload).toMatchObject({
      state: 'working',
      lifecycleOwnerState: 'working',
      agentType: 'claude',
      leadState: 'done',
      leadInterrupted: true,
      lastAssistantMessage: 'nested complete',
      subagents: [expect.objectContaining({ id: 'owner-reviewer' })]
    })
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)).toMatchObject({
      source: ownerRecord?.source,
      state: ownerRecord?.state
    })
  })

  it('keeps owner attention and its actionable identity sticky across nested events', () => {
    vi.useFakeTimers()
    vi.setSystemTime(6_000)
    productionEvent('claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'owner permission',
      session_id: 'attention-owner-session'
    })
    const ownerAttention = productionEvent('claude', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      toolUseId: 'owner-permission-id',
      agentId: 'owner-agent-id',
      agentType: 'owner-agent-type',
      session_id: 'attention-owner-session'
    })
    expect(ownerAttention?.payload).toMatchObject({
      state: 'waiting',
      toolName: 'Bash',
      toolInput: 'git status'
    })
    const ownerRecord = state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)

    for (const [index, nestedPayload] of [
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'nested work',
        session_id: 'nested-session'
      },
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'dangerous nested command' },
        toolUseId: 'nested-permission-id',
        agentType: 'nested-agent-type',
        session_id: 'nested-session'
      },
      {
        hook_event_name: 'Stop',
        last_assistant_message: 'nested finished',
        session_id: 'nested-session'
      }
    ].entries()) {
      vi.setSystemTime(6_001 + index)
      const event = productionEvent('codex', nestedPayload)
      expect(event).toMatchObject({
        providerSession: { id: 'attention-owner-session' },
        toolUseId: 'owner-permission-id',
        toolAgentId: 'owner-agent-id',
        toolAgentType: 'owner-agent-type',
        payload: {
          state: 'waiting',
          lifecycleOwnerState: 'waiting',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'git status'
        }
      })
    }
    expect(state.lastToolByPaneKey.get(PANE_KEY)).toMatchObject({
      toolName: 'Bash',
      toolInput: 'git status'
    })
    expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)).toMatchObject({
      source: ownerRecord?.source,
      state: ownerRecord?.state
    })
  })

  it.each([
    {
      label: 'Claude child',
      source: 'claude',
      start: { hook_event_name: 'SubagentStart', agent_id: 'hydrated-claude-child' },
      stop: { hook_event_name: 'SubagentStop', agent_id: 'hydrated-claude-child' }
    },
    {
      label: 'Claude teammate',
      source: 'claude',
      start: { hook_event_name: 'SubagentStart', agent_id: 'areviewer-deadbeef' },
      stop: { hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' }
    },
    {
      label: 'Codex child',
      source: 'codex',
      start: { hook_event_name: 'SubagentStart', agent_id: 'hydrated-codex-child' },
      stop: { hook_event_name: 'SubagentStop', agent_id: 'hydrated-codex-child' }
    },
    {
      label: 'Copilot child',
      source: 'copilot',
      start: {
        hook_event_name: 'subagentStart',
        transcriptPath: '/tmp/hydrated-copilot.jsonl'
      },
      stop: {
        hook_event_name: 'subagentStop',
        transcriptPath: '/tmp/hydrated-copilot.jsonl'
      }
    },
    {
      label: 'OpenCode child',
      source: 'opencode',
      start: { hook_event_name: 'SubagentStart', child_id: 'hydrated-opencode-child' },
      stop: { hook_event_name: 'SubagentStop', child_id: 'hydrated-opencode-child' }
    },
    {
      label: 'MiMo child',
      source: 'mimo-code',
      start: { hook_event_name: 'SubagentStart', child_id: 'hydrated-mimo-child' },
      stop: { hook_event_name: 'SubagentStop', child_id: 'hydrated-mimo-child' }
    }
  ] as const)(
    'ignores an unmatched $label stop but drains the same hydrated child',
    ({ source, start, stop }) => {
      expect(providerEvent(source, stop)).toBeNull()
      expect(state.claudeSubagentRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(state.agentSubagentLifecycleByPaneKey.has(PANE_KEY)).toBe(false)
      expect(state.agentLifecycleOwnerByPaneKey.has(PANE_KEY)).toBe(false)

      const started = providerEvent(source, start)
      const snapshot = started?.payload.subagents?.[0]
      expect(snapshot).toBeDefined()
      if (!snapshot) {
        throw new Error(`Expected ${source} start to produce a child snapshot`)
      }

      state = createHookListenerState()
      seedAgentSubagentLifecycleFromSnapshots(state, PANE_KEY, source, [snapshot], {
        leadState: 'done'
      })
      const drained = providerEvent(source, stop)
      expect(drained?.payload).toMatchObject({
        state: 'done',
        agentType: source,
        subagents: undefined
      })
      expect(state.agentLifecycleOwnerByPaneKey.get(PANE_KEY)).toMatchObject({
        source,
        state: 'done'
      })
    }
  )
})
