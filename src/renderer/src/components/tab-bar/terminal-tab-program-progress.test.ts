import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { ProgramStatusFacet } from '../../../../shared/program-status/facet'
import {
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus,
  resolveTerminalTabProgramProgress
} from './terminal-tab-activity-status'

const TAB_ID = 'tab-1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const NOW = 10_000

function facet(progress: number): ProgramStatusFacet {
  return { state: 'working', progress, observedAt: NOW }
}

function entry(
  paneKey: string,
  state: AgentStatusEntry['state'],
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey,
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'codex',
    ...overrides
  }
}

/** Resolve the tab's status first, as SortableTab does, then its progress. */
function tabProgress(...entries: AgentStatusEntry[]): number | undefined {
  const agentStatusByPaneKey = Object.fromEntries(entries.map((e) => [e.paneKey, e]))
  const status = resolveTerminalTabActivityStatus({
    tab: { id: TAB_ID, title: 'Codex' },
    agentStatusByPaneKey,
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] }
  })
  return resolveTerminalTabProgramProgress({ tabId: TAB_ID, status, agentStatusByPaneKey })
}

beforeEach(() => {
  resetTerminalTabActivityFlagsCacheForTest()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  resetTerminalTabActivityFlagsCacheForTest()
})

describe('resolveTerminalTabProgramProgress', () => {
  it("shows the most recently updated working pane's progress", () => {
    expect(
      tabProgress(
        entry(`${TAB_ID}:${LEAF_A}`, 'working', { updatedAt: NOW - 5, programStatus: facet(20) }),
        entry(`${TAB_ID}:${LEAF_B}`, 'working', { programStatus: facet(75) })
      )
    ).toBe(75)
  })

  it('shows no progress when no pane reports one', () => {
    expect(tabProgress(entry(`${TAB_ID}:${LEAF_A}`, 'working'))).toBeUndefined()
  })

  it('shows no progress for a done row with a live facet', () => {
    expect(
      tabProgress(entry(`${TAB_ID}:${LEAF_A}`, 'done', { programStatus: facet(40) }))
    ).toBeUndefined()
  })

  it('shows no progress for a stale working row', () => {
    const staleAt = NOW - AGENT_STATUS_STALE_AFTER_MS - 1
    expect(
      tabProgress(
        entry(`${TAB_ID}:${LEAF_A}`, 'working', {
          updatedAt: staleAt,
          stateStartedAt: staleAt,
          programStatus: facet(40)
        })
      )
    ).toBeUndefined()
  })

  it('shows no progress for a restored, unconfirmed row', () => {
    expect(
      tabProgress(
        entry(`${TAB_ID}:${LEAF_A}`, 'working', {
          restoredUnconfirmed: true,
          programStatus: facet(40)
        })
      )
    ).toBeUndefined()
  })

  it('reads progress from a legacy numeric pane key', () => {
    expect(tabProgress(entry(`${TAB_ID}:3`, 'working', { programStatus: facet(60) }))).toBe(60)
  })

  it('takes progress from the pane driving the permission ring, not a working sibling', () => {
    expect(
      tabProgress(
        entry(`${TAB_ID}:${LEAF_A}`, 'working', { programStatus: facet(20) }),
        entry(`${TAB_ID}:${LEAF_B}`, 'blocked', {
          updatedAt: NOW - 5,
          programStatus: { state: 'blocked', progress: 90, observedAt: NOW }
        })
      )
    ).toBe(90)
  })
})
