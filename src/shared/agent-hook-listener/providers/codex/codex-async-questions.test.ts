import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import {
  pendingCodexAsyncQuestion,
  skipCodexAsyncQuestion,
  trackCodexAsyncQuestions
} from './codex-async-questions'
import { normalizeCodexEvent } from './codex-events'

it('opens an accepted call on PostToolUse and shows its first unanswered question', () => {
  const state = createHookListenerState()
  const call = {
    tool_name: 'request_user_input_async',
    tool_use_id: 'call-1',
    tool_input: { questions: [{ title: 'First?' }, { title: 'Second?' }, { title: 'Third?' }] }
  }
  const reply = (index: number) =>
    trackCodexAsyncQuestions(state, 'pane', 'UserPromptSubmit', {
      prompt: `<send_user_message_question_reply>${JSON.stringify([
        {
          answer: 'a',
          questionItemId: JSON.stringify(['request_user_input_async', 'call-1', index])
        }
      ])}</send_user_message_question_reply>`
    })?.title

  // Codex sends PreToolUse before validating, so only PostToolUse proves the TUI shows it.
  expect(trackCodexAsyncQuestions(state, 'pane', 'PreToolUse', call)).toBeUndefined()
  expect(trackCodexAsyncQuestions(state, 'pane', 'PostToolUse', call)?.title).toBe('First?')
  expect(reply(0)).toBe('Second?')
  expect(skipCodexAsyncQuestion(state, 'pane')).toBe(true)
  expect(reply(1)).toBe('Third?')
  expect(reply(2)).toBeUndefined()
})

it("names the oldest call's question, as Codex's TUI focuses it", () => {
  const state = createHookListenerState()
  const ask = (id: string, title: string) => {
    const call = {
      tool_name: 'request_user_input_async',
      tool_use_id: id,
      tool_input: { questions: [{ title }] }
    }
    trackCodexAsyncQuestions(state, 'pane', 'PreToolUse', call)
    return trackCodexAsyncQuestions(state, 'pane', 'PostToolUse', call)
  }

  ask('call-a', 'SQLite or Postgres?')
  expect(ask('call-b', 'Which port?')).toMatchObject({
    title: 'SQLite or Postgres?',
    prompt: JSON.stringify({ questions: [{ title: 'Which port?' }] })
  })
  expect(skipCodexAsyncQuestion(state, 'pane')).toBe(true)
  expect(pendingCodexAsyncQuestion(state, 'pane')?.title).toBe('Which port?')
})

it('keeps the question title as the row input while another tool runs', () => {
  const state = createHookListenerState()
  const call = {
    tool_name: 'request_user_input_async',
    tool_use_id: 'call-1',
    tool_input: { questions: [{ title: 'Which port?' }] }
  }
  normalizeCodexEvent(state, 'UserPromptSubmit', 'go', 'pane', { prompt: 'go' })
  normalizeCodexEvent(state, 'PreToolUse', '', 'pane', call)
  normalizeCodexEvent(state, 'PostToolUse', '', 'pane', call)
  const row = normalizeCodexEvent(state, 'PreToolUse', '', 'pane', {
    tool_name: 'exec_command',
    tool_use_id: 'call-2',
    tool_input: { cmd: 'sleep 5' }
  })
  expect(row).toMatchObject({ toolName: 'request_user_input_async', toolInput: 'Which port?' })
})
