import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { selectSleepingRecordParkExemptTabIds } from './sleeping-record-park-exemption'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function sleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> & Pick<SleepingAgentSessionRecord, 'paneKey'>
): SleepingAgentSessionRecord {
  return {
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: 'prompt',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('selectSleepingRecordParkExemptTabIds', () => {
  it.each([
    [`tab-1:${LEAF_ID}`, 'tab-1'],
    ['tab-legacy:0', 'tab-legacy']
  ])('derives the owner from a valid pane key (%s)', (paneKey, tabId) => {
    const records = { [paneKey]: sleepingRecord({ paneKey }) }

    expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1')]).toEqual([tabId])
  })

  it('prefers the persisted tab id over the pane key owner', () => {
    const paneKey = `tab-stale:${LEAF_ID}`
    const records = { [paneKey]: sleepingRecord({ paneKey, tabId: 'tab-current' }) }

    expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1')]).toEqual(['tab-current'])
  })

  it('does not invent an owner for a delimiter-less pane key', () => {
    const records = {
      'orphan-pane-key': sleepingRecord({ paneKey: 'orphan-pane-key' })
    }

    expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1')]).toEqual([])
  })

  it('skips records that cannot resume in this worktree', () => {
    const records = {
      [`tab-other:${LEAF_ID}`]: sleepingRecord({
        paneKey: `tab-other:${LEAF_ID}`,
        worktreeId: 'wt-2'
      }),
      [`tab-done:${LEAF_ID}`]: sleepingRecord({ paneKey: `tab-done:${LEAF_ID}`, state: 'done' }),
      [`tab-blocked:${LEAF_ID}`]: sleepingRecord({
        paneKey: `tab-blocked:${LEAF_ID}`,
        automaticResumeBlockedBy: 'legacy-orchestration-worker'
      })
    }

    expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1')]).toEqual([])
  })
})
