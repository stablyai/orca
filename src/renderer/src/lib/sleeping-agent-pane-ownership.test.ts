import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { activationTreatsNoteAsFinished } from './sleeping-agent-pane-ownership'

function note(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'conv-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('activationTreatsNoteAsFinished', () => {
  it.each([
    ['a worktree-sleep done note', true, note({ origin: 'worktree-sleep' })],
    ['a legacy originless done note', true, note()],
    ['a finished turn idle anchor (live done)', true, note({ origin: 'live' })],
    [
      'an interrupted worktree-sleep note',
      true,
      note({ origin: 'worktree-sleep', interrupted: true })
    ],
    ['an interrupted live turn', false, note({ origin: 'live', interrupted: true })],
    ['a quit capture', false, note({ origin: 'quit' })],
    ['a running turn (live working)', false, note({ origin: 'live', state: 'working' })]
  ])('%s -> %s', (_label, expected, record) => {
    expect(activationTreatsNoteAsFinished(record)).toBe(expected)
  })
})
