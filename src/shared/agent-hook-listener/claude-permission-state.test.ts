import { describe, expect, it } from 'vitest'
import captures from './__fixtures__/declined-permission-hooks.json'
import { normalizeHookPayload } from '../agent-hook-listener'
import { createHookListenerState, clearPaneCacheState, movePaneCacheState } from './listener-state'
import { makePaneKey } from '../stable-pane-id'
import { invalidateRejectedClaudeHook } from './claude-permission-state'
import { markClaudeLeadTurnInterrupted } from './providers/claude-roster-state'

const pane = makePaneKey('permission', '11111111-1111-4111-8111-111111111111')
const session = '11111111-1111-4111-8111-111111111111'
const prompt = '22222222-2222-4222-8222-222222222222'

function harness(complete = true) {
  const state = createHookListenerState()
  const send = (hook_event_name: string, fields: Record<string, unknown> = {}, replay = false) =>
    normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: pane,
        payload: { session_id: session, prompt_id: prompt, hook_event_name, ...fields }
      },
      'production',
      { isReplay: replay }
    )
  if (complete) {
    send('SessionStart', { source: 'startup' })
  }
  send('UserPromptSubmit', { prompt: 'Continue after a declined request' })
  return { state, send }
}
const request = { tool_name: 'Read', tool_input: { file_path: '/outside.txt' } }

describe('Claude permission lifetime', () => {
  it.each(['claudeDecline', 'claudeParallel', 'claudeChild'] as const)(
    'projects the recorded %s request until its own batch, preserving its card through sibling work',
    (capture) => {
      const state = createHookListenerState()
      let card: ReturnType<typeof normalizeHookPayload>
      let pending = false
      for (const raw of captures[capture]) {
        const row = normalizeHookPayload(
          state,
          'claude',
          { paneKey: pane, payload: raw },
          'production'
        )
        if (raw.hook_event_name === 'PermissionRequest') {
          card = row
          pending = true
          expect(row?.claudePermissionState).toMatchObject({
            knowledge: 'complete',
            pending: { toolUseId: expect.any(String) }
          })
        }
        if (raw.hook_event_name === 'PostToolBatch' && !('agent_id' in raw)) {
          pending = false
        }
        if (!row || !pending || !card) {
          continue
        }
        expect(row.payload).toMatchObject({
          state: 'waiting',
          toolName: card.payload.toolName,
          toolInput: card.payload.toolInput,
          interactivePrompt: card.payload.interactivePrompt,
          lastAssistantMessage: card.payload.lastAssistantMessage,
          lastAssistantMessageIsToolOutput: card.payload.lastAssistantMessageIsToolOutput,
          mainAgent: card.payload.mainAgent
        })
      }
      expect(pending).toBe(false)
      expect(state.claudePermissionByPaneKey.get(pane)?.pending).toHaveLength(0)
    }
  )

  it('uses the entire structural input, retains ambiguous candidates, and ignores delayed repeats', () => {
    const { send } = harness()
    const a = { tool_name: 'Read', tool_input: { file_path: '/same-preview', offset: 1 } }
    const b = { tool_name: 'Read', tool_input: { offset: 2, file_path: '/same-preview' } }
    send('PreToolUse', { ...a, tool_use_id: 'a' })
    send('PreToolUse', { ...b, tool_use_id: 'b' })
    expect(send('PermissionRequest', a)?.claudePermissionState?.pending?.toolUseId).toBe('a')
    expect(send('PostToolUse', { ...b, tool_use_id: 'b' })?.payload.state).toBe('waiting')
    expect(send('PostToolBatch', { tool_calls: [{ ...a, tool_use_id: 'a' }] })?.payload.state).toBe(
      'working'
    )
    expect(send('PreToolUse', { ...a, tool_use_id: 'a' })?.payload.state).toBe('working')
    expect(send('PermissionRequest', a)?.claudePermissionState).toEqual({
      version: 1,
      knowledge: 'complete'
    })

    send('UserPromptSubmit', { prompt: 'Again' })
    send('PreToolUse', { ...a, tool_use_id: 'c' })
    send('PreToolUse', { ...a, tool_use_id: 'd' })
    expect(send('PermissionRequest', a)?.claudePermissionState?.pending).toEqual({})
    expect(send('PostToolUse', { ...a, tool_use_id: 'c' })?.payload.state).toBe('waiting')
    expect(send('PostToolUseFailure', { ...a, tool_use_id: 'd' })?.payload.state).toBe('working')
  })

  it('retains a child-owned wait through root endings and restores the actual lead verdict and clock', () => {
    const { state, send } = harness()
    // Constructed reverse ownership: the recording has a main wait with child traffic only.
    send('Stop', { is_interrupt: true })
    const lead = state.claudeLeadStateByPaneKey.get(pane)
    const child = { ...request, agent_id: 'child-1', agent_type: 'general-purpose' }
    send('PreToolUse', { ...child, tool_use_id: 'child-read' })
    const waiting = send('PermissionRequest', child)
    expect(waiting?.payload.mainAgent).toMatchObject({
      state: 'done',
      outcome: 'cancellation',
      stateStartedAt: lead?.stateStartedAt
    })
    expect(
      send('PostToolBatch', { tool_calls: [{ ...request, tool_use_id: 'child-read' }] })?.payload
        .state
    ).toBe('waiting')
    expect(send('UserPromptSubmit', { prompt: 'Root continues' })?.payload.state).toBe('waiting')
    send('Stop', { is_interrupt: true })
    const lastLead = state.claudeLeadStateByPaneKey.get(pane)
    send('PostToolBatch', {
      agent_id: 'child-1',
      tool_calls: [{ ...request, tool_use_id: 'child-read' }]
    })
    const ended = send('SubagentStop', { agent_id: 'child-1' })
    expect(ended?.payload).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: {
        state: 'done',
        outcome: 'cancellation',
        stateStartedAt: lastLead?.stateStartedAt
      }
    })
  })

  it('keeps question and elicitation waits on their existing path while tracking ordinary permission privately', () => {
    const { send } = harness()
    send('PreToolUse', { ...request, tool_use_id: 'read' })
    send('PermissionRequest', request)
    const question = {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'question',
      tool_input: { questions: [{ question: 'Which file?', options: [] }] }
    }
    const row = send('PreToolUse', question)
    expect(row?.payload.toolName).toBe('AskUserQuestion')
    expect(row?.claudePermissionState).toEqual({ version: 1, knowledge: 'unknown' })
    expect(send('PermissionRequest', question)?.payload.toolName).toBe('AskUserQuestion')
    expect(send('PostToolUse', question)?.payload).toMatchObject({
      state: 'waiting',
      toolName: 'Read'
    })
    expect(
      send('Elicitation', { mcp_server_name: 'files', message: 'Allow?' })?.claudePermissionState
    ).toEqual({ version: 1, knowledge: 'unknown' })
    expect(send('ElicitationResult')?.payload).toMatchObject({ state: 'waiting', toolName: 'Read' })
    expect(
      send('PostToolBatch', { tool_calls: [{ ...request, tool_use_id: 'read' }] })?.payload.state
    ).toBe('working')
  })

  it('never certifies cold, replayed or interrupted observation as complete; retains known waits after a transport gap', () => {
    const { state, send } = harness(false)
    expect(
      send('SessionStart', { source: 'startup' }, true)?.claudePermissionState?.knowledge
    ).toBe('unknown')
    send('SessionStart', { source: 'resume' })
    send('PreToolUse', { ...request, tool_use_id: 'read' })
    send('PermissionRequest', request)
    invalidateRejectedClaudeHook(state, { 'x-orca-pane-key': pane })
    expect(
      send('PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
        tool_use_id: 'sibling'
      })?.claudePermissionState
    ).toMatchObject({ knowledge: 'unknown', pending: { toolUseId: 'read' } })
    markClaudeLeadTurnInterrupted(state, pane)
    expect(send('PermissionRequest', request)?.claudePermissionState).toEqual({
      version: 1,
      knowledge: 'unknown'
    })
    const moved = makePaneKey('moved', '22222222-2222-4222-8222-222222222222')
    movePaneCacheState(state, pane, moved)
    expect(state.claudePermissionByPaneKey.has(pane)).toBe(false)
    clearPaneCacheState(state, moved)
    expect(state.claudePermissionByPaneKey.size).toBe(0)
  })

  it('processes an entire batch before the compatibility cap, and bounded correlation never certifies a lost request', () => {
    const { send } = harness()
    send('PreToolUse', { ...request, tool_use_id: 'pending' })
    send('PermissionRequest', request)
    const tool_calls = Array.from({ length: 20 }, (_, i) => ({
      tool_name: 'Bash',
      tool_input: { command: `echo ${i}` },
      tool_use_id: `sibling-${i}`
    }))
    const settled = send('PostToolBatch', {
      tool_calls: [...tool_calls, { ...request, tool_use_id: 'pending' }]
    })
    expect(settled?.payload.state).toBe('working')
    expect(settled?.claudePermissionState).toEqual({ version: 1, knowledge: 'complete' })
    expect(settled?.claudeSettledRequests).toHaveLength(16)
    expect(settled?.claudeSettledRequests?.[0].toolUseId).toBe('pending')
    for (let i = 0; i < 513; i++) {
      send('PreToolUse', { ...request, tool_use_id: `overflow-${i}` })
    }
    expect(send('PostToolBatch', { tool_calls: [] })?.claudePermissionState?.knowledge).toBe(
      'unknown'
    )
  })

  it('preserves the recorded Codex decline Interrupt and next-turn approval contract', () => {
    const state = createHookListenerState()
    let approvals = 0
    for (const raw of captures.codex) {
      const row = normalizeHookPayload(
        state,
        'codex',
        { paneKey: pane, payload: raw },
        'production'
      )
      expect(row?.claudePermissionState).toBeUndefined()
      if (raw.hook_event_name === 'Interrupt') {
        expect(row?.payload).toMatchObject({ state: 'done', interrupted: true })
      }
      if (raw.hook_event_name === 'PermissionRequest') {
        approvals++
        expect(row?.payload.state).toBe('waiting')
      }
      if (raw.hook_event_name === 'PostToolUse') {
        expect(row?.payload.state).toBe('working')
      }
    }
    expect(approvals).toBe(2)
  })
})
