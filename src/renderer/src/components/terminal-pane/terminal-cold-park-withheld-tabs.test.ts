import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { ParkVerdictFlipRecord } from './terminal-park-verdict-flip-telemetry'
import { withholdUnparkableTerminalTabs } from './terminal-cold-park-withheld-tabs'

const coverage = vi.hoisted(() => ({ byTabId: new Map<string, boolean>() }))

vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: (_worktreeId: string, tab: TerminalTab) =>
    coverage.byTabId.get(tab.id) ?? true
}))

const WORKTREE = 'repo::/wt'

function terminalTab(id: string): TerminalTab {
  return { id, ptyId: `${WORKTREE}@@${id}`, title: id } as TerminalTab
}

function pinnedRecord(pinnedUntilMs: number | null): ParkVerdictFlipRecord {
  return {
    parked: false,
    windowStartMs: 0,
    flips: 0,
    notified: false,
    burstStartMs: 0,
    burstFlips: 0,
    pinnedUntilMs
  }
}

beforeEach(() => {
  coverage.byTabId.clear()
})

describe('withholdUnparkableTerminalTabs', () => {
  it('parks a covered tab with no pin', () => {
    const { parkedTabIds, parkVerdictPinUntilMsByTabId } = withholdUnparkableTerminalTabs({
      worktreeId: WORKTREE,
      terminalTabs: [terminalTab('tab-a')],
      coldParkedTabIds: new Set(['tab-a']),
      parkVerdictRecords: new Map(),
      nowMs: 1_000
    })

    expect(parkedTabIds).toEqual(new Set(['tab-a']))
    expect(parkVerdictPinUntilMsByTabId.size).toBe(0)
  })

  // Why both returned values matter: the caller needs the deadline to schedule
  // the recheck that lets the tab park again once damping lapses.
  it('withholds a pinned tab and reports its deadline', () => {
    const records = new Map([['tab-a', pinnedRecord(9_000)]])

    const { parkedTabIds, parkVerdictPinUntilMsByTabId } = withholdUnparkableTerminalTabs({
      worktreeId: WORKTREE,
      terminalTabs: [terminalTab('tab-a')],
      coldParkedTabIds: new Set(['tab-a']),
      parkVerdictRecords: records,
      nowMs: 1_000
    })

    expect(parkedTabIds.has('tab-a')).toBe(false)
    expect(parkVerdictPinUntilMsByTabId.get('tab-a')).toBe(9_000)
  })

  it('withholds a tab the watchers cannot cover', () => {
    coverage.byTabId.set('tab-a', false)

    const { parkedTabIds, parkVerdictPinUntilMsByTabId } = withholdUnparkableTerminalTabs({
      worktreeId: WORKTREE,
      terminalTabs: [terminalTab('tab-a')],
      coldParkedTabIds: new Set(['tab-a']),
      parkVerdictRecords: new Map(),
      nowMs: 1_000
    })

    expect(parkedTabIds.has('tab-a')).toBe(false)
    // No pin: an uncovered tab has no damping deadline to recheck at.
    expect(parkVerdictPinUntilMsByTabId.size).toBe(0)
  })

  // Why: an expired pin must hand the tab back to the parking policy, not
  // strand it mounted for the rest of the session.
  it('parks a tab whose pin has lapsed', () => {
    const records = new Map([['tab-a', pinnedRecord(500)]])

    const { parkedTabIds, parkVerdictPinUntilMsByTabId } = withholdUnparkableTerminalTabs({
      worktreeId: WORKTREE,
      terminalTabs: [terminalTab('tab-a')],
      coldParkedTabIds: new Set(['tab-a']),
      parkVerdictRecords: records,
      nowMs: 1_000
    })

    expect(parkedTabIds.has('tab-a')).toBe(true)
    expect(parkVerdictPinUntilMsByTabId.size).toBe(0)
  })

  it('does not consult non-candidates and leaves the input set untouched', () => {
    const coldParkedTabIds = new Set(['tab-a'])
    coverage.byTabId.set('tab-b', false)

    const { parkedTabIds } = withholdUnparkableTerminalTabs({
      worktreeId: WORKTREE,
      terminalTabs: [terminalTab('tab-a'), terminalTab('tab-b')],
      coldParkedTabIds,
      parkVerdictRecords: new Map(),
      nowMs: 1_000
    })

    expect(parkedTabIds).toEqual(new Set(['tab-a']))
    expect(coldParkedTabIds).toEqual(new Set(['tab-a']))
  })
})
