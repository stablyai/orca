import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from '../agent-hook-listener'
import { PANE_KEY } from '../agent-hook-listener-test-harness'
import { makePaneKey } from '../stable-pane-id'
import providerPayloads from '../__fixtures__/claude-elicitation-payloads.json'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  movePaneCacheState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from './listener-state'
import { markClaudeLeadTurnInterrupted } from './providers/claude-roster-state'

const formFixture = providerPayloads.find((row) => row.request.mode === 'form')
const urlFixture = providerPayloads.find((row) => row.request.mode === 'url')
if (!formFixture || !urlFixture) {
  throw new Error('Captured provider payloads must include form and URL elicitation')
}
const formRequest = formFixture.request
const formResult = formFixture.result
const urlRequest = urlFixture.request
const urlResult = urlFixture.result

function emit(
  state: HookListenerState,
  payload: Record<string, unknown>,
  paneKey = PANE_KEY
): ReturnType<typeof normalizeHookPayload> {
  const result = normalizeHookPayload(
    state,
    'claude',
    { paneKey, payload: { session_id: formRequest.session_id, ...payload } },
    'production'
  )
  if (result) {
    seedLegacyAgentStatusForTests(state, result)
  }
  return result
}

function start(state: HookListenerState): ReturnType<typeof normalizeHookPayload> {
  emit(state, { hook_event_name: 'UserPromptSubmit', prompt: 'Implement the requested change' })
  return emit(state, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/src/feature.ts' },
    tool_use_id: 'lead-read'
  })
}

function tool(
  hookEventName: string,
  toolUseId = 'mcp-call',
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    hook_event_name: hookEventName,
    tool_name: 'mcp__audit-mcp__query',
    tool_use_id: toolUseId,
    tool_input: { query: 'fixture' },
    ...extra
  }
}

describe('Claude elicitation attention lifecycle', () => {
  it.each(providerPayloads)(
    '$version $request.mode $result.action preserves the lead turn and tool/prompt',
    ({ request, result }) => {
      const state = createHookListenerState()
      const before = start(state)
      const waiting = emit(state, request)
      expect(waiting?.payload).toMatchObject({
        state: 'waiting',
        prompt: before?.payload.prompt,
        toolName: before?.payload.toolName,
        toolInput: before?.payload.toolInput,
        mainAgent: before?.payload.mainAgent
      })
      expect(waiting?.hasExplicitPrompt).toBe(false)
      const settled = emit(state, result)
      expect(settled?.payload).toEqual(before?.payload)
      expect(settled?.turnEndedAt).toBeUndefined()
      expect(emit(state, result)).toBeNull()
    }
  )

  it.each([
    { session_id: 'another-session' },
    { agent_id: 'another-child' },
    { mcp_server_name: 'other-mcp' },
    { mode: 'url' },
    { elicitation_id: 'unexpected-id' },
    { action: 'unknown' },
    { action: undefined },
    { mcp_server_name: '' }
  ])('rejects an unmatched form result without retiring its wait: %j', (mismatch) => {
    const state = createHookListenerState()
    start(state)
    expect(emit(state, formRequest)?.payload.state).toBe('waiting')
    expect(emit(state, { ...formResult, ...mismatch })).toBeNull()
    expect(
      emit(state, { hook_event_name: 'PostToolUse', tool_use_id: 'unrelated' })?.payload.state
    ).toBe('waiting')
    expect(emit(state, formResult)?.payload.state).toBe('working')
  })

  it('requires the URL request id and rejects a stale result from a prior URL request', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, urlRequest)
    expect(emit(state, { ...urlResult, elicitation_id: undefined })).toBeNull()
    expect(emit(state, { ...urlResult, elicitation_id: 'prior-request' })).toBeNull()
    expect(emit(state, urlResult)?.payload.state).toBe('working')
    emit(state, { ...urlRequest, elicitation_id: 'next-request' })
    expect(emit(state, urlResult)).toBeNull()
    expect(emit(state, { ...urlResult, elicitation_id: 'next-request' })?.payload.state).toBe(
      'working'
    )
  })

  it('keeps distinct URL requests pending and makes identified redelivery idempotent', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, urlRequest)
    emit(state, urlRequest)
    emit(state, { ...urlRequest, elicitation_id: 'second-url-request' })
    expect(emit(state, urlResult)?.payload.state).toBe('waiting')
    expect(emit(state, urlResult)).toBeNull()
    expect(emit(state, { ...urlResult, elicitation_id: 'second-url-request' })?.payload.state).toBe(
      'working'
    )
  })

  it('shows an idle session elicitation without inventing a main-agent turn', () => {
    const state = createHookListenerState()
    const idle = emit(state, { hook_event_name: 'SessionStart', source: 'resume' })
    const waiting = emit(state, formRequest)
    expect(waiting?.payload.state).toBe('waiting')
    expect(waiting?.payload.mainAgent).toEqual(idle?.payload.mainAgent)
    const settled = emit(state, formResult)
    expect(settled?.payload.state).toBe('done')
    expect(settled?.payload.mainAgent).toEqual(idle?.payload.mainAgent)
    expect(settled?.turnEndedAt).toBeUndefined()
  })

  it('keeps other servers waiting after one result and ignores unrelated tool completions', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, formRequest)
    emit(state, { ...formRequest, mcp_server_name: 'second-mcp' })
    expect(emit(state, tool('PostToolUse', 'unrelated'))?.payload.state).toBe('waiting')
    expect(emit(state, formResult)?.payload.state).toBe('waiting')
    expect(emit(state, { ...formResult, mcp_server_name: 'second-mcp' })?.payload.state).toBe(
      'working'
    )
  })

  it('keeps lead and child requests distinct even on the same server', () => {
    const state = createHookListenerState()
    const before = start(state)
    emit(state, formRequest)
    const childWait = emit(state, { ...formRequest, agent_id: 'child-1' })
    expect(childWait?.payload.mainAgent).toEqual(before?.payload.mainAgent)
    expect(emit(state, formResult)?.payload.state).toBe('waiting')
    expect(emit(state, { ...formResult, agent_id: 'child-2' })).toBeNull()
    expect(emit(state, { ...formResult, agent_id: 'child-1' })?.payload.state).toBe('working')
  })

  it('a lead Stop clears only lead requests and preserves a child wait', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, formRequest)
    emit(state, { ...formRequest, agent_id: 'child-1' })
    const stopped = emit(state, {
      hook_event_name: 'Stop',
      last_assistant_message: 'Lead finished'
    })
    expect(stopped?.payload.state).toBe('waiting')
    expect(stopped?.payload.mainAgent?.state).toBe('done')
    expect(emit(state, formResult)).toBeNull()
    expect(emit(state, { ...formResult, agent_id: 'child-1' })?.payload.state).not.toBe('waiting')
  })

  it('a child stop clears only its own wait while the lead still needs attention', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, formRequest)
    emit(state, { ...formRequest, agent_id: 'child-1' })
    expect(
      emit(state, { hook_event_name: 'SubagentStop', agent_id: 'child-1' })?.payload.state
    ).toBe('waiting')
    expect(emit(state, { ...formResult, agent_id: 'child-1' })).toBeNull()
    expect(emit(state, formResult)?.payload.state).not.toBe('waiting')
  })

  it('a teammate idle boundary clears only the matching teammate attention', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, { ...formRequest, agent_id: 'areviewer-00000001' })
    emit(state, { ...formRequest, agent_id: 'awriter-00000002' })
    expect(
      emit(state, { hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' })?.payload.state
    ).toBe('waiting')
    expect(emit(state, { ...formResult, agent_id: 'areviewer-00000001' })).toBeNull()
    expect(emit(state, { ...formResult, agent_id: 'awriter-00000002' })?.payload.state).toBe(
      'working'
    )
  })

  it('an elicitation result cannot dismiss an independent permission wait', () => {
    const state = createHookListenerState()
    start(state)
    const permission = emit(state, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'deploy' },
      tool_use_id: 'approval'
    })
    emit(state, formRequest)
    const settled = emit(state, formResult)
    expect(settled?.payload.state).toBe('waiting')
    expect(settled?.payload.toolName).toBe('Bash')
    expect(settled?.payload.mainAgent).toEqual(permission?.payload.mainAgent)
  })

  it.each(['startup', 'resume', 'clear'])(
    'drops stale waits at an idle %s SessionStart',
    (source) => {
      const state = createHookListenerState()
      start(state)
      emit(state, formRequest)
      emit(state, { ...formRequest, agent_id: 'child-1' })
      expect(emit(state, { hook_event_name: 'SessionStart', source })?.payload.state).toBe('done')
      expect(emit(state, formResult)).toBeNull()
      expect(emit(state, { ...formResult, agent_id: 'child-1' })).toBeNull()
    }
  )

  it('replaces session-owned waits without letting an old result reanchor the new session', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, formRequest)
    const replacement = { session_id: 'replacement-session' }
    emit(state, { hook_event_name: 'UserPromptSubmit', prompt: 'New session task', ...replacement })
    emit(state, { ...formRequest, ...replacement })
    expect(emit(state, formResult)).toBeNull()
    expect(state.claudeSessionOwnerByPaneKey.get(PANE_KEY)).toBe(replacement.session_id)
    expect(emit(state, { ...formResult, ...replacement })?.payload.state).toBe('working')
  })

  it('moves wait ownership with its pane and removes it during pane and listener resets', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, formRequest)
    const movedPane = makePaneKey('moved-tab', '44444444-4444-4444-8444-444444444444')
    movePaneCacheState(state, PANE_KEY, movedPane)
    expect(emit(state, formResult)).toBeNull()
    expect(emit(state, { hook_event_name: 'PostToolUse' }, movedPane)?.payload.state).toBe(
      'waiting'
    )
    expect(emit(state, formResult, movedPane)?.payload.state).toBe('working')
    emit(state, formRequest, movedPane)
    clearPaneCacheState(state, movedPane)
    expect(emit(state, formResult, movedPane)).toBeNull()
    start(state)
    emit(state, formRequest)
    clearAllListenerCaches(state)
    expect(emit(state, formResult)).toBeNull()
  })

  it('interrupts foreground attention without retiring a child-owned request', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, formRequest)
    emit(state, { ...formRequest, agent_id: 'child-1' })
    expect(markClaudeLeadTurnInterrupted(state, PANE_KEY).state).toBe('waiting')
    expect(emit(state, formResult)).toBeNull()
    const settled = emit(state, { ...formResult, agent_id: 'child-1' })
    expect(settled?.payload.state).not.toBe('waiting')
    expect(settled?.payload.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
  })

  it('settles only the exact uniquely captured MCP tool completion for the same owner and server', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, tool('PreToolUse'))
    emit(state, formRequest)
    expect(emit(state, tool('PostToolUse', 'wrong-call'))?.payload.state).toBe('waiting')
    expect(
      emit(state, tool('PostToolUse', 'mcp-call', { agent_id: 'child-1' }))?.payload.state
    ).toBe('waiting')
    expect(
      emit(state, tool('PostToolUse', 'mcp-call', { tool_name: 'mcp__other-mcp__query' }))?.payload
        .state
    ).toBe('waiting')
    expect(emit(state, tool('PostToolUse'))?.payload.state).toBe('working')
    expect(emit(state, formResult)).toBeNull()
  })

  it('does not infer a fallback from multiple active tool calls on the same server', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, tool('PreToolUse', 'mcp-1'))
    emit(state, tool('PreToolUse', 'mcp-2'))
    emit(state, formRequest)
    expect(emit(state, tool('PostToolUse', 'mcp-1'))?.payload.state).toBe('waiting')
    expect(emit(state, tool('PostToolUse', 'mcp-2'))?.payload.state).toBe('waiting')
    expect(emit(state, formResult)?.payload.state).toBe('working')
  })

  it.each([{}, { message: 'A second form from the same server' }])(
    'fails closed for overlapping idless requests until their owner ends: %j',
    (secondRequest) => {
      const state = createHookListenerState()
      start(state)
      emit(state, { ...formRequest, ...secondRequest })
      emit(state, formRequest)
      expect(emit(state, formResult)).toBeNull()
      expect(emit(state, formResult)).toBeNull()
      expect(emit(state, { hook_event_name: 'PostToolUse' })?.payload.state).toBe('waiting')
      expect(emit(state, { hook_event_name: 'Stop' })?.payload.state).toBe('done')
      expect(emit(state, formResult)).toBeNull()
    }
  )

  it('recovers an unanswered form when its captured tool fails', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, tool('PreToolUse'))
    emit(state, formRequest)
    const failed = emit(
      state,
      tool('PostToolUseFailure', 'mcp-call', { error: 'Server unavailable' })
    )
    expect(failed?.payload.state).toBe('working')
    expect(failed?.payload.mainAgent?.state).toBe('working')
    expect(emit(state, formResult)).toBeNull()
  })
})

describe('Claude elicitation bounded ownership and session cleanup', () => {
  it('retires owner-scoped overflow at the lead boundary without dismissing a child wait', () => {
    const state = createHookListenerState()
    start(state)
    for (let index = 0; index < 65; index++) {
      emit(state, { ...formRequest, mcp_server_name: `server-${index}` })
    }
    emit(state, { ...formRequest, agent_id: 'child' })
    expect(emit(state, { hook_event_name: 'Stop' })?.payload.state).toBe('waiting')
    expect(emit(state, { hook_event_name: 'SubagentStop', agent_id: 'child' })?.payload.state).toBe(
      'done'
    )
  })

  it.each(['clear', 'resume', 'prompt_input_exit', 'other'])(
    'clears matching SessionEnd %s without process metadata',
    (reason) => {
      const state = createHookListenerState()
      start(state)
      emit(state, formRequest)
      emit(state, { hook_event_name: 'SessionEnd', reason, session_id: 'another-session' })
      expect(emit(state, { hook_event_name: 'PostToolUse' })?.payload.state).toBe('waiting')
      emit(state, { hook_event_name: 'SessionEnd', reason, agent_id: 'child' })
      expect(emit(state, { hook_event_name: 'PostToolUse' })?.payload.state).toBe('waiting')
      emit(state, { hook_event_name: 'SessionEnd', reason })
      expect(emit(state, formResult)).toBeNull()
      expect(emit(state, { hook_event_name: 'PostToolUse' })?.payload.state).toBe('working')
    }
  )

  it('bounds retained requests, active calls and overflow owners until the session reset', () => {
    const state = createHookListenerState()
    start(state)
    for (let index = 0; index < 200; index++) {
      emit(state, tool('PreToolUse', `tool-${index}`))
      emit(state, { ...formRequest, agent_id: `child-${index}` })
    }
    const registry = state.claudeElicitationByPaneKey.get(PANE_KEY)
    expect(registry?.pending).toHaveLength(64)
    expect(registry?.activeTools.size).toBe(64)
    expect(registry?.overflowOwners.size).toBe(64)
    expect(registry?.unattributedOverflow).toBe(true)
    expect(emit(state, { hook_event_name: 'SessionStart', source: 'clear' })?.payload.state).toBe(
      'done'
    )
    expect(state.claudeElicitationByPaneKey.has(PANE_KEY)).toBe(false)
  })

  it('does not let a stale child stop retire the current child request', () => {
    const state = createHookListenerState()
    start(state)
    emit(state, { ...formRequest, agent_id: 'child' })
    expect(
      emit(state, { hook_event_name: 'SubagentStop', agent_id: 'child', session_id: 'old-session' })
        ?.payload.state
    ).toBe('waiting')
    expect(emit(state, { ...formResult, agent_id: 'child' })?.payload.state).toBe('working')
  })
})

it('does not infer a unique MCP call from an incomplete active-tool inventory', () => {
  const state = createHookListenerState()
  start(state)
  for (let index = 0; index < 64; index++) {
    emit(state, tool('PreToolUse', `call-${index}`, { tool_name: `mcp__server-${index}__query` }))
  }
  emit(state, tool('PreToolUse', 'untracked-call', { tool_name: 'mcp__server-0__query' }))
  emit(state, { ...formRequest, mcp_server_name: 'server-0' })
  expect(
    emit(state, tool('PostToolUse', 'call-0', { tool_name: 'mcp__server-0__query' }))?.payload.state
  ).toBe('waiting')
  expect(emit(state, { ...formResult, mcp_server_name: 'server-0' })?.payload.state).toBe('working')
})

it('does not keep an earlier unique tool association when a repeated form overlaps another call', () => {
  const state = createHookListenerState()
  start(state)
  emit(state, tool('PreToolUse', 'first-call'))
  emit(state, formRequest)
  emit(state, tool('PreToolUse', 'second-call'))
  emit(state, formRequest)
  expect(emit(state, tool('PostToolUse', 'first-call'))?.payload.state).toBe('waiting')
  expect(emit(state, tool('PostToolUse', 'second-call'))?.payload.state).toBe('waiting')
  expect(emit(state, formResult)).toBeNull()
  expect(emit(state, { hook_event_name: 'Stop' })?.payload.state).toBe('done')
})

it.each(['SubagentStop', 'StopFailure', 'TeammateIdle'])(
  'retires a first-event child elicitation on %s without leaving cached attention',
  (hookEventName) => {
    const state = createHookListenerState()
    const agentId = hookEventName === 'TeammateIdle' ? 'afirst-abcd' : 'first-child'
    emit(state, { ...formRequest, agent_id: agentId })
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('waiting')
    const ended = emit(state, {
      hook_event_name: hookEventName,
      agent_id: agentId,
      teammate_name: 'first'
    })
    expect(ended?.payload.state).toBe('working')
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')
    expect(emit(state, { ...formResult, agent_id: agentId })).toBeNull()
  }
)
