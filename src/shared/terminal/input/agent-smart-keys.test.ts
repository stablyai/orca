import { describe, expect, it } from 'vitest'
import { resolveAgentSmartKeys } from './agent-smart-keys'

const approval = JSON.stringify({ approval: { tool: 'Bash', summary: 'pnpm tc' } })
const questions = JSON.stringify({
  questions: [
    { question: 'Where?', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    { question: 'Which?', options: [{ label: 'x' }, { label: 'y' }] }
  ]
})

function keys(agent: string, row: Parameters<typeof resolveAgentSmartKeys>[1]) {
  const set = resolveAgentSmartKeys(agent, row)
  return set && { state: set.state, keys: set.keys.map((key) => [key.combo, ...key.writes]) }
}

describe('resolveAgentSmartKeys', () => {
  it('reads permission from the approval envelope and question from the questions JSON', () => {
    expect(keys('claude', { state: 'waiting', interactivePrompt: approval })).toEqual({
      state: 'permission',
      keys: [
        ['1', '1'],
        ['2', '2'],
        ['Esc', '\x1b']
      ]
    })
    expect(
      keys('claude', {
        state: 'waiting',
        interactivePrompt: questions,
        toolName: 'AskUserQuestion'
      })
    ).toEqual({
      state: 'question',
      keys: [
        ['1', '1'],
        ['2', '2'],
        ['3', '3'],
        ['←', '\x1b[D'],
        ['→', '\x1b[C'],
        ['Esc', '\x1b']
      ]
    })
  })

  it('answers Codex approvals per request and stops OpenCode with two Escapes', () => {
    expect(keys('codex', { state: 'waiting', interactivePrompt: approval })?.keys).toEqual([
      ['y', 'y'],
      ['a', 'a'],
      ['n', 'n']
    ])
    expect(keys('opencode', { state: 'working' })?.keys).toEqual([['Esc Esc', '\x1b', '\x1b']])
    expect(keys('claude', { state: 'done', interrupted: true })?.state).toBe('idle')
  })

  it('shows nothing for an unknown agent, state or prompt', () => {
    expect(keys('gemini', { state: 'working' })).toBeNull()
    expect(keys('claude', { state: 'waiting' })).toBeNull()
    expect(keys('codex', { state: 'waiting', interactivePrompt: questions })).toBeNull()
    expect(keys('codex', { state: 'done' })).toBeNull()
  })
})
