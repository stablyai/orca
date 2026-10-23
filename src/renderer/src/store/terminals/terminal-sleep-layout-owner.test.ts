import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { recordLayoutApply } from '@/runtime/layout-apply-send'
import {
  recordPaneSleepThroughLayoutOwner,
  recordPaneWakeThroughLayoutOwner,
  recordSleepingRecordChangesThroughLayoutOwner
} from './terminal-sleep-layout-owner'

const mocks = vi.hoisted(() => ({ send: vi.fn<typeof recordLayoutApply>() }))

vi.mock('@/runtime/layout-apply-send', () => ({ recordLayoutApply: mocks.send }))

const WT = 'repo1::/path/wt1'
const STATE = {}
const A1 = 'tab-a:11111111-1111-4111-8111-111111111111'
const A2 = 'tab-a:22222222-2222-4222-8222-222222222222'
const B1 = 'tab-b:33333333-3333-4333-8333-333333333333'

function record(paneKey: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: WT,
    agent: 'codex',
    providerSession: { key: 'session_id', id: paneKey },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1
  }
}

/** A window holding these terminal tabs in WT. */
function holding(tabIds: string[]): { tabsByWorktree: Record<string, TerminalTab[]> } {
  return {
    tabsByWorktree: {
      [WT]: tabIds.map((id) => ({
        id,
        ptyId: null,
        worktreeId: WT,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }))
    }
  }
}

describe('sleep and wake through the layout owner', () => {
  beforeEach(() => {
    mocks.send.mockReset()
  })

  it('sends one sleep per tab naming only the panes it stopped', () => {
    const records = {
      [A1]: record(A1),
      [A2]: record(A2),
      [B1]: record(B1),
      // A legacy pane key names no pane main holds.
      'tab-a:1': record('tab-a:1')
    }

    recordPaneSleepThroughLayoutOwner(STATE, WT, records)

    expect(mocks.send.mock.calls.map((call) => call[2])).toEqual([
      { type: 'sleep', tabId: 'tab-a', paneKeys: [A1, A2], records: [record(A1), record(A2)] },
      { type: 'sleep', tabId: 'tab-b', paneKeys: [B1], records: [record(B1)] }
    ])
  })

  it('sends nothing when nothing slept, as a worktree removal', () => {
    recordPaneSleepThroughLayoutOwner(STATE, WT, {})

    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('wakes the one pane the window resumed', () => {
    recordPaneWakeThroughLayoutOwner(STATE, WT, A2)

    expect(mocks.send).toHaveBeenCalledWith(STATE, WT, {
      type: 'wake',
      tabId: 'tab-a',
      paneKeys: [A2]
    })
  })

  it('records a live capture and a dropped record without stopping or starting anything', () => {
    const live = { ...record(A1), state: 'working' as const, origin: 'live' as const }
    const kept = record(B1)

    recordSleepingRecordChangesThroughLayoutOwner(
      holding(['tab-a', 'tab-b']),
      { [A2]: record(A2), [B1]: kept },
      { [A1]: live, [B1]: kept }
    )

    expect(mocks.send.mock.calls.map((call) => call[2])).toEqual([
      { type: 'sleep', tabId: 'tab-a', paneKeys: [A1], records: [live], recordOnly: true },
      { type: 'wake', tabId: 'tab-a', paneKeys: [A2], recordOnly: true }
    ])
  })

  it('sends nothing for a tab the window closed: main dropped its records with the tab', () => {
    recordSleepingRecordChangesThroughLayoutOwner(holding(['tab-b']), { [A2]: record(A2) }, {})
    // A periodic capture from a stale agent status can name the closed tab again.
    recordSleepingRecordChangesThroughLayoutOwner(holding(['tab-b']), {}, { [A1]: record(A1) })

    expect(mocks.send).not.toHaveBeenCalled()
  })
})
