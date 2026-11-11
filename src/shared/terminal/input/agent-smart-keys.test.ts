import { describe, expect, it } from 'vitest'
import { resolveAgentSmartKeys } from './agent-smart-keys'

const approval = JSON.stringify({ approval: { tool: 'Bash', summary: 'pnpm tc' } })
const questions = JSON.stringify({
  questions: [
    { question: 'Where?', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    { question: 'Which?', options: [{ label: 'x' }, { label: 'y' }] }
  ]
})

describe('resolveAgentSmartKeys', () => {
  it('tells a permission prompt from a question by the prompt shape', () => {
    expect(
      resolveAgentSmartKeys('claude', { state: 'waiting', interactivePrompt: approval })?.state
    ).toBe('permission')
    const ask = resolveAgentSmartKeys('claude', {
      state: 'waiting',
      interactivePrompt: questions,
      toolName: 'AskUserQuestion'
    })
    expect(ask?.state).toBe('question')
    // The phone can't see the open question tab, so it offers digits for the longest one.
    expect(ask?.keys.filter((key) => /^\d$/.test(key.combo)).map((key) => key.writes)).toEqual([
      ['1'],
      ['2'],
      ['3']
    ])
  })

  it("opens Codex's async question with ⇧← before its digits", () => {
    const ask = resolveAgentSmartKeys('codex', {
      state: 'waiting',
      toolName: 'request_user_input_async',
      interactivePrompt: JSON.stringify({
        questions: [{ title: 'Which db?', options: ['a', 'b', 'c'] }, { title: 'Table name?' }]
      })
    })
    expect(ask?.state).toBe('question')
    expect(ask?.keys.map((key) => key.writes.join(''))).toEqual([
      '\x1b[1;2D',
      '1',
      '2',
      '3',
      '\r',
      '\x1d'
    ])
  })

  it('shows nothing for an unknown agent, state or prompt', () => {
    expect(resolveAgentSmartKeys('gemini', { state: 'working' })).toBeNull()
    expect(resolveAgentSmartKeys('claude', { state: 'waiting' })).toBeNull()
    expect(
      resolveAgentSmartKeys('codex', { state: 'waiting', interactivePrompt: questions })
    ).toBeNull()
    expect(resolveAgentSmartKeys('codex', { state: 'done' })).toBeNull()
  })
})
