import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import { liveResumeRecordChange } from './agent-resume-record-from-status'

const slept: SleepingAgentSessionRecord = {
  paneKey: 'tab-1:1',
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-a' },
  prompt: '',
  state: 'done',
  capturedAt: 200,
  updatedAt: 200,
  origin: 'worktree-sleep'
}

describe('liveResumeRecordChange', () => {
  it('keeps an Agent Sleep record when its finished turn is checkpointed again', () => {
    const live = { ...slept, origin: 'live' as const, capturedAt: 100, updatedAt: 100 }
    expect(liveResumeRecordChange(slept, live)).toBeNull()
  })

  it('replaces it once the same conversation is working again', () => {
    const live = { ...slept, origin: 'live' as const, state: 'working' as const }
    expect(liveResumeRecordChange(slept, live)).toEqual({ set: live })
  })

  it('replaces it for a different conversation', () => {
    const live = {
      ...slept,
      origin: 'live' as const,
      providerSession: { key: 'session_id' as const, id: 'session-b' }
    }
    expect(liveResumeRecordChange(slept, live)).toEqual({ set: live })
  })
})
