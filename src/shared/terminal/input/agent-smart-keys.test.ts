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

  it('declines one Codex approval with n and stops OpenCode with two separate Escapes', () => {
    const codexNo = resolveAgentSmartKeys('codex', {
      state: 'waiting',
      interactivePrompt: approval
    })?.keys.find((key) => key.name === 'no')
    expect(codexNo?.writes).toEqual(['n'])
    const openCodeStop = resolveAgentSmartKeys('opencode', { state: 'working' })?.keys.find(
      (key) => key.name === 'stop'
    )
    expect(openCodeStop?.writes).toEqual(['\x1b', '\x1b'])
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
