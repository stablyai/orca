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
  it('reads an approval with the cards’ own allow and deny keys', () => {
    const read = readAgentPromptAnswers(waiting(approval), 'claude', 'p1', true)
    expect(read?.prompt).toEqual({
      kind: 'approval',
      promptId: 'p1',
      tool: 'Bash',
      summary: 'rm -rf build',
      options: [
        { id: 'allow_once', label: 'Allow once' },
        { id: 'reject_once', label: 'Reject' }
      ]
    })
    expect(Object.fromEntries(read!.keysByOption)).toEqual({
      allow_once: '1',
      reject_once: '\x1b'
    })
    expect(
      readAgentPromptAnswers(waiting(approval), 'codex', 'p1', true)?.keysByOption.get('allow_once')
    ).toBe('1')
  })

  it('reads a one-question single choice with each option’s selector key', () => {
    for (const agent of ['claude', 'codex']) {
      const read = readAgentPromptAnswers(waiting(question(), 'AskUserQuestion'), agent, 'p2', true)
      expect(read?.prompt).toEqual({
        kind: 'question',
        promptId: 'p2',
        question: 'Which color?',
        header: 'Color',
        options: [
          { id: '1', label: 'Red', description: 'warm' },
          { id: '2', label: 'Blue' }
        ]
      })
      expect(Object.fromEntries(read!.keysByOption)).toEqual({ '1': '1', '2': '2' })
    }
  })

  it('leaves to Orca what one keystroke cannot answer', () => {
    const unsupported = { kind: 'unsupported', promptId: 'p' }
    const cases = [
      waiting(question({}, 2)),
      waiting(question({ multiSelect: true })),
      waiting(question({ options: [] })),
      waiting('not json'),
      { state: 'blocked' as const }
    ]
    for (const row of cases) {
      expect(readAgentPromptAnswers(row, 'claude', 'p', true)?.prompt).toEqual(unsupported)
    }
  })

  it('leaves every prompt to Orca for an agent without hooks or known keys', () => {
    expect(readAgentPromptAnswers(waiting(approval), 'claude', 'p', false)?.prompt.kind).toBe(
      'unsupported'
    )
    expect(readAgentPromptAnswers(waiting(approval), 'aider', 'p', true)?.prompt.kind).toBe(
      'unsupported'
    )
  })

  it('reads nothing while the agent is not waiting on the user', () => {
    expect(
      readAgentPromptAnswers({ state: 'working', interactivePrompt: approval }, 'claude', 'p', true)
    ).toBeNull()
    expect(readAgentPromptAnswers({ state: 'done' }, 'claude', 'p', true)).toBeNull()
  })
})
