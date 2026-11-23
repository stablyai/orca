import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeClaudeEvent } from './claude-events'

const pane = 'pane'

const send = (
  state: ReturnType<typeof createHookListenerState>,
  eventName: string,
  payload: Record<string, unknown>
) => normalizeClaudeEvent(state, eventName, '', pane, payload)

const finishedTurn = () => {
  const state = createHookListenerState()
  send(state, 'UserPromptSubmit', { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001' })
  send(state, 'Stop', { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001' })
  return state
}

it('keeps a finished pane done through an idle compaction that restores context files', () => {
  const state = finishedTurn()
  const docs = { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001', trigger: 'auto' }

  send(state, 'PreCompact', docs)
  send(state, 'PostCompact', docs)
  for (const eventName of ['PreToolUse', 'PostToolUse']) {
    const payload = send(state, eventName, {
      ...docs,
      tool_name: 'Read',
      tool_use_id: 'toolu_1'
    })
    expect(payload).toMatchObject({ state: 'done' })
  }

  expect(state.claudeLeadStateByPaneKey.get(pane)?.state).toBe('done')
})

it('leaves a running turn alone, since an in-turn compaction still ends with its Stop', () => {
  const state = createHookListenerState()
  send(state, 'UserPromptSubmit', { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001' })
  send(state, 'PreToolUse', {
    prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1'
  })

  send(state, 'PreCompact', { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001', trigger: 'auto' })
  expect(
    send(state, 'PostToolUse', {
      prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1'
    })
  ).toMatchObject({ state: 'working' })

  send(state, 'Stop', { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001' })
  expect(state.claudeLeadStateByPaneKey.get(pane)?.state).toBe('done')
})

it('leaves a turn waiting on a person alone', () => {
  const state = createHookListenerState()
  send(state, 'UserPromptSubmit', { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001' })
  send(state, 'PreToolUse', {
    prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_1'
  })

  send(state, 'PreCompact', { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001', trigger: 'auto' })

  expect(
    send(state, 'PostToolUse', {
      prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_1'
    })
  ).not.toBeNull()
})

it('resumes normal routing once a new prompt starts the next turn', () => {
  const state = finishedTurn()
  send(state, 'PreCompact', { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001', trigger: 'auto' })

  expect(
    send(state, 'UserPromptSubmit', { prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000002' })
  ).toMatchObject({
    state: 'working'
  })
  expect(
    send(state, 'PreToolUse', {
      prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000002',
      tool_name: 'Read',
      tool_use_id: 'toolu_2'
    })
  ).toMatchObject({ state: 'working' })
})

it('does not fence a manual compaction, which already clears the pane itself', () => {
  const state = finishedTurn()

  send(state, 'PreCompact', {
    prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001',
    trigger: 'manual'
  })
  expect(
    send(state, 'PostToolUse', {
      prompt_id: '0f0e6d8c-1111-4a2b-9c3d-000000000001',
      tool_name: 'Read',
      tool_use_id: 'toolu_1'
    })
  ).toMatchObject({ state: 'working' })
})
