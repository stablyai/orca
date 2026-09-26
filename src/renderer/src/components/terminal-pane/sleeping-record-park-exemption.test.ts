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

function stateWith(sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>): {
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
} {
  return { sleepingAgentSessionsByPaneKey }
}

describe('selectSleepingRecordParkExemptTabIds', () => {
  it.each([
    [`tab-1:${LEAF_ID}`, 'tab-1'],
    ['tab-legacy:0', 'tab-legacy']
  ])('derives the owner from a valid pane key (%s)', (paneKey, tabId) => {
    const records = { [paneKey]: sleepingRecord({ paneKey }) }

    expect([...selectSleepingRecordParkExemptTabIds(stateWith(records), 'wt-1')]).toEqual([tabId])
  })

  it('prefers the persisted tab id over the pane key owner', () => {
    const paneKey = `tab-stale:${LEAF_ID}`
    const records = { [paneKey]: sleepingRecord({ paneKey, tabId: 'tab-current' }) }

    expect([...selectSleepingRecordParkExemptTabIds(stateWith(records), 'wt-1')]).toEqual([
      'tab-current'
    ])
  })

  it('does not invent an owner for a delimiter-less pane key', () => {
    const records = {
      'orphan-pane-key': sleepingRecord({ paneKey: 'orphan-pane-key' })
    }

    expect([...selectSleepingRecordParkExemptTabIds(stateWith(records), 'wt-1')]).toEqual([])
  })

  it('rebuilds when the record map changes and reuses the result when it does not', () => {
    const paneKey = `tab-1:${LEAF_ID}`
    const records = { [paneKey]: sleepingRecord({ paneKey }) }
    const state = stateWith(records)

    const first = selectSleepingRecordParkExemptTabIds(state, 'wt-1')
    expect(selectSleepingRecordParkExemptTabIds(state, 'wt-1')).toBe(first)

    const nextPaneKey = `tab-2:${LEAF_ID}`
    const grown = stateWith({ ...records, [nextPaneKey]: sleepingRecord({ paneKey: nextPaneKey }) })

    expect([...selectSleepingRecordParkExemptTabIds(grown, 'wt-1')]).toEqual(['tab-1', 'tab-2'])
  })

  // Why: a memo that serves a stale generation after the workspace's records are
  // dropped would pin a hidden pane mounted for the rest of the session.
  it('drops a worktree exemption once its records leave the map', () => {
    const paneKey = `tab-1:${LEAF_ID}`
    const populated = stateWith({ [paneKey]: sleepingRecord({ paneKey }) })
    expect([...selectSleepingRecordParkExemptTabIds(populated, 'wt-1')]).toEqual(['tab-1'])

    expect([...selectSleepingRecordParkExemptTabIds(stateWith({}), 'wt-1')]).toEqual([])
  })
})
