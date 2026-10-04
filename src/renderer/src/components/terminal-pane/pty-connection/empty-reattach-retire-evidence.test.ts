import { describe, expect, it } from 'vitest'
import {
  hasEmptyReattachRetireEvidence,
  isHibernationDoneRecord
} from './empty-reattach-retire-evidence'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

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

function resumeStartup(
  record: SleepingAgentSessionRecord | null,
  useLiveEntry = false
): ColdRestoreAgentResumeStartup {
  return {
    command: 'codex resume conv-1',
    agent: 'codex',
    resumeProviderSession: { key: 'session_id', id: 'conv-1' },
    launchConfig: { agentArgs: '', agentEnv: {} },
    launchToken: 'token-1',
    useLiveEntry,
    hasSleepingRecord: record !== null,
    sleepingRecordEntry: record ? { paneKey: record.paneKey, record } : null
  }
}

const WORKTREE_SLEEP_DONE = note({ origin: 'worktree-sleep' })

describe('isHibernationDoneRecord', () => {
  it.each([
    ['a legacy originless done note', true, note()],
    ['a worktree-sleep done note', true, WORKTREE_SLEEP_DONE],
    ['a live done note (the idle anchor of a running pane)', false, note({ origin: 'live' })],
    [
      'a live done note marked not interrupted',
      false,
      note({ origin: 'live', interrupted: false })
    ],
    ['a quit done note', false, note({ origin: 'quit' })],
    [
      'a worktree-sleep note still working',
      false,
      note({ origin: 'worktree-sleep', state: 'working' })
    ]
  ])('%s -> %s', (_label, expected, record) => {
    expect(isHibernationDoneRecord(record)).toBe(expected)
  })
})

describe('hasEmptyReattachRetireEvidence', () => {
  it.each([
    ['a local pty', 'local-pty-1'],
    ['a local daemon session id', 'wt-1@@daemon-session-1']
  ])('retires %s under a hibernation done note', (_label, ptyId) => {
    expect(hasEmptyReattachRetireEvidence(ptyId, resumeStartup(WORKTREE_SLEEP_DONE))).toBe(true)
  })

  it('never retires a remote runtime pty, whose disconnect leaves the host PTY alive', () => {
    expect(
      hasEmptyReattachRetireEvidence('remote:env-1@@term_1', resumeStartup(WORKTREE_SLEEP_DONE))
    ).toBe(false)
  })

  it.each([
    ['no resume startup', undefined],
    ['a startup resuming the live entry', resumeStartup(WORKTREE_SLEEP_DONE, true)],
    ['a startup without a sleeping note', resumeStartup(null)],
    ['a live done note', resumeStartup(note({ origin: 'live' }))]
  ])('keeps a local pty with %s', (_label, startup) => {
    expect(hasEmptyReattachRetireEvidence('local-pty-1', startup)).toBe(false)
  })
})
