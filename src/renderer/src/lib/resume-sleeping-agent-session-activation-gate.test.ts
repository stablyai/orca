import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { isInvalidWorktreeActivationRecord } from './resume-sleeping-agent-session'

describe('isInvalidWorktreeActivationRecord age policy', () => {
  const baseRecord = {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 's1' },
    prompt: '',
    state: 'waiting',
    origin: 'quit'
  } as const

  it('accepts a record that idled hours before quit', () => {
    const now = Date.now()
    // capturedAt at quit, updatedAt 3 hours earlier — previously rejected.
    const record = { ...baseRecord, capturedAt: now, updatedAt: now - 3 * 60 * 60 * 1000 }
    expect(isInvalidWorktreeActivationRecord(record as SleepingAgentSessionRecord)).toBe(false)
  })

  it('rejects a record older than 14 days', () => {
    const now = Date.now()
    const capturedAt = now - 15 * 24 * 60 * 60 * 1000
    const record = { ...baseRecord, capturedAt, updatedAt: capturedAt }
    expect(isInvalidWorktreeActivationRecord(record as SleepingAgentSessionRecord)).toBe(true)
  })
})
