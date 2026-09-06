import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { selectSleepingRecordParkExemptTabIds } from './sleeping-record-park-exemption'

const NO_LIVE_PANES = { ptyIdsByTabId: {}, terminalLayoutsByTabId: {} }

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

    expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1', NO_LIVE_PANES)]).toEqual([
      tabId
    ])
  })

  it('prefers the persisted tab id over the pane key owner', () => {
    const paneKey = `tab-stale:${LEAF_ID}`
    const records = { [paneKey]: sleepingRecord({ paneKey, tabId: 'tab-current' }) }

    expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1', NO_LIVE_PANES)]).toEqual([
      'tab-current'
    ])
  })

  it('does not invent an owner for a delimiter-less pane key', () => {
    const records = {
      'orphan-pane-key': sleepingRecord({ paneKey: 'orphan-pane-key' })
    }

    expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1', NO_LIVE_PANES)]).toEqual([])
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

    expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1', NO_LIVE_PANES)]).toEqual([])
  })
  it.each(['working', 'waiting', 'done'] as const)(
    'does not unpark a live checkpoint in state %s with an owned PTY',
    (state) => {
      const paneKey = `tab-1:${LEAF_ID}`
      const records = {
        [paneKey]: sleepingRecord({ paneKey, origin: 'live', state, interrupted: true })
      }
      const livePanes = {
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf' as const, leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
          }
        }
      }
      expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1', livePanes)]).toEqual([])
    }
  )

  it.each(['live', 'quit', 'worktree-sleep'] as const)(
    'keeps %s recovery eligible when only a saved PTY remains',
    (origin) => {
      const paneKey = `tab-1:${LEAF_ID}`
      const records = { [paneKey]: sleepingRecord({ paneKey, origin }) }
      const livePanes = {
        ptyIdsByTabId: {},
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf' as const, leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: 'stale-pty' }
          }
        }
      }
      expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1', livePanes)]).toEqual([
        'tab-1'
      ])
    }
  )

  it('does not let a live sibling suppress recovery of a missing split pane', () => {
    const paneKey = `tab-1:${LEAF_ID}`
    const records = { [paneKey]: sleepingRecord({ paneKey, origin: 'live' }) }
    const livePanes = {
      ptyIdsByTabId: { 'tab-1': ['sibling-pty'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split' as const,
            direction: 'horizontal' as const,
            ratio: 0.5,
            first: { type: 'leaf' as const, leafId: LEAF_ID },
            second: { type: 'leaf' as const, leafId: '22222222-2222-4222-8222-222222222222' }
          },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'missing-pty' }
        }
      }
    }
    expect([...selectSleepingRecordParkExemptTabIds(records, 'wt-1', livePanes)]).toEqual(['tab-1'])
  })
})
