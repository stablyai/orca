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

  it("keeps the Agent Sleep record but takes a finished turn's changed effort", () => {
    const live = {
      ...slept,
      origin: 'live' as const,
      providerSession: { key: 'session_id' as const, id: 'session-a', effort: 'high' }
    }
    expect(liveResumeRecordChange(slept, live)).toEqual({
      set: { ...slept, providerSession: { key: 'session_id', id: 'session-a', effort: 'high' } }
    })
  })

  it('keeps the account a slept conversation ran on when its finished turn lost it', () => {
    const pinned = {
      ...slept,
      launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId: 'acct-b' }
    }
    const live = {
      ...slept,
      origin: 'live' as const,
      launchConfig: { agentArgs: '--model opus', agentEnv: {} }
    }
    expect(liveResumeRecordChange(pinned, live)).toEqual({
      set: {
        ...slept,
        launchConfig: { agentArgs: '--model opus', agentEnv: {}, claudeAccountId: 'acct-b' }
      }
    })
    expect(liveResumeRecordChange(pinned, { ...slept, origin: 'live' })).toBeNull()
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
