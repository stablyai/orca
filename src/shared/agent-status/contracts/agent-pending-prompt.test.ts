import { describe, expect, it } from 'vitest'
import { readAgentPromptAnswers } from './agent-pending-prompt'

const approval = JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })

function question(overrides: Record<string, unknown> = {}, count = 1): string {
  const one = {
    question: 'Which color?',
    header: 'Color',
    multiSelect: false,
    options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
    ...overrides
  }
  return JSON.stringify({ questions: Array.from({ length: count }, () => one) })
}

function waiting(interactivePrompt: string, toolName?: string) {
  return { state: 'waiting' as const, interactivePrompt, ...(toolName ? { toolName } : {}) }
}

describe('readAgentPromptAnswers', () => {
  it('leaves to Orca what one keystroke cannot answer', () => {
    const unsupported = {
      prompt: { kind: 'unsupported', promptId: 'p' },
      keysByOption: new Map()
    }
    const cases = [
      waiting(question({}, 2)),
      waiting(question({ multiSelect: true })),
      waiting(question({ options: [] })),
      waiting('not json'),
      { state: 'blocked' as const }
    ]
    for (const agent of ['claude', 'codex']) {
      for (const row of cases) {
        expect(readAgentPromptAnswers(row, agent, 'p', true)).toEqual(unsupported)
      }
    }
    const asyncQuestion = JSON.stringify({
      questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }]
    })
    expect(
      readAgentPromptAnswers(waiting(asyncQuestion, 'request_user_input_async'), 'codex', 'p', true)
    ).toEqual(unsupported)
  })

  it('leaves every prompt to Orca for an agent without hooks or known keys', () => {
    const unsupported = {
      prompt: { kind: 'unsupported', promptId: 'p' },
      keysByOption: new Map()
    }
    expect(readAgentPromptAnswers(waiting(approval), 'claude', 'p', false)).toEqual(unsupported)
    expect(readAgentPromptAnswers(waiting(approval), 'aider', 'p', true)).toEqual(unsupported)
    expect(
      readAgentPromptAnswers(waiting(question(), 'AskUserQuestion'), 'grok', 'p', true)
    ).toEqual(unsupported)
  })
})
