import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import {
  hasUnreadAgentCompletionForTerminalTab,
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from './terminal-tab-activity-status'

const TAB_ID = 'tab-1'
const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const NOW = 10_000

const TAB: Pick<TerminalTab, 'id' | 'title'> = { id: TAB_ID, title: 'Codex' }

/** Build a canonical pane-status fixture for one tab leaf. */
function entry(
  leafId: string,
  state: AgentStatusEntry['state'],
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  const paneKey = `${TAB_ID}:${leafId}`
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

/** One live PTY for the tab so title/liveness gates pass. */
const LIVE_PTY = { [TAB_ID]: ['pty-1'] }

beforeEach(() => {
  resetTerminalTabActivityFlagsCacheForTest()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  resetTerminalTabActivityFlagsCacheForTest()
})

describe('resolveTerminalTabActivityStatus', () => {
  it('reports a fresh hook working state', () => {
    const working = entry(FIRST_LEAF_ID, 'working')
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: { [working.paneKey]: working },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('working')
  })

  it('lets a needs-input pane outrank a working sibling', () => {
    const working = entry(FIRST_LEAF_ID, 'working')
    const waiting = entry(SECOND_LEAF_ID, 'waiting')
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: {
          [working.paneKey]: working,
          [waiting.paneKey]: waiting
        },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('permission')
  })

  it('reports a completed turn as done', () => {
    const done = entry(FIRST_LEAF_ID, 'done')
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: { [done.paneKey]: done },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('done')
  })

  it('treats an interrupted done as done, matching the worktree card', () => {
    const interrupted = entry(FIRST_LEAF_ID, 'done', { interrupted: true })
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: { [interrupted.paneKey]: interrupted },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('done')
  })

  it('falls back to a live working title when hook status is stale', () => {
    const stale = entry(FIRST_LEAF_ID, 'done', { updatedAt: 0 })
    vi.setSystemTime(31 * 60 * 1000)
    expect(
      resolveTerminalTabActivityStatus({
        tab: { id: TAB_ID, title: 'Codex working' },
        agentStatusByPaneKey: { [stale.paneKey]: stale },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('working')
  })

  it('de-spins a stale working tab on an epoch bump without a new map reference', () => {
    // Why: the freshness scheduler bumps agentStatusEpoch (not the map ref) at
    // the 30m stale boundary. The flag cache must invalidate on that bump, or an
    // abandoned tab keeps spinning while the sidebar (epoch-keyed) de-spins.
    const working = entry(FIRST_LEAF_ID, 'working')
    const agentStatusByPaneKey = { [working.paneKey]: working }
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey,
        agentStatusEpoch: 0,
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('working')

    vi.setSystemTime(31 * 60 * 1000)
    // Same map reference, bumped epoch — the entry is now stale.
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey,
        agentStatusEpoch: 1,
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('active')
  })

  it('does not treat a preserved title on a sleeping tab as activity', () => {
    expect(
      resolveTerminalTabActivityStatus({
        tab: { id: TAB_ID, title: 'Codex working' },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'Codex working' } },
        ptyIdsByTabId: { [TAB_ID]: [] }
      })
    ).toBe('inactive')
  })

  it('reads a needs-input hook as permission', () => {
    const blocked = entry(FIRST_LEAF_ID, 'blocked')
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: { [blocked.paneKey]: blocked },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('permission')
  })

  it('reads a legacy numeric pane key, matching the sidebar summary', () => {
    const working = entry(FIRST_LEAF_ID, 'working', { paneKey: `${TAB_ID}:3` })
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: { [working.paneKey]: working },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('working')
  })

  it('reports a live shell with no agent as active (no activity glyph)', () => {
    expect(
      resolveTerminalTabActivityStatus({
        tab: { id: TAB_ID, title: 'zsh' },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('active')
  })
})

describe('hasUnreadAgentCompletionForTerminalTab', () => {
  it('matches unread completion panes to their owning tab', () => {
    expect(
      hasUnreadAgentCompletionForTerminalTab(
        {
          [`${TAB_ID}:${FIRST_LEAF_ID}`]: true,
          [`tab-2:${SECOND_LEAF_ID}`]: true
        },
        TAB_ID
      )
    ).toBe(true)
  })

  it('ignores completion panes owned by other tabs', () => {
    expect(
      hasUnreadAgentCompletionForTerminalTab({ [`tab-2:${SECOND_LEAF_ID}`]: true }, TAB_ID)
    ).toBe(false)
  })
})
