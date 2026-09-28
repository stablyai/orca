import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import { noteArmsHibernatedPaneWake } from './pty-exit-hibernate'

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

describe('noteArmsHibernatedPaneWake', () => {
  it.each([
    ['a hibernation note (worktree-sleep done)', true, note({ origin: 'worktree-sleep' })],
    ['a legacy originless done note', true, note()],
    // Why: #16308's incidental widening, kept; pty-connection-hibernation-wake.test.ts pins its effect.
    ['a finished turn idle anchor (live done)', true, note({ origin: 'live' })],
    ['an interrupted live turn', false, note({ origin: 'live', interrupted: true })],
    ['a quit capture', false, note({ origin: 'quit' })],
    [
      'a manual-sleep note still working',
      false,
      note({ origin: 'worktree-sleep', state: 'working' })
    ]
  ])('%s -> %s', (_label, expected, record) => {
    expect(noteArmsHibernatedPaneWake(record)).toBe(expected)
  })
})
