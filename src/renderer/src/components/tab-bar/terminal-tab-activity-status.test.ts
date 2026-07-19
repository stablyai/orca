import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import {
  hasUnreadAgentCompletionForTerminalTab,
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityPresentation,
  resolveTerminalTabUnreadActivity,
  resolveTerminalTabActivityStatus,
  shouldShowTerminalTabUnreadActivity
} from './terminal-tab-activity-status'

const TAB_ID = 'tab-1'
const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const THIRD_LEAF_ID = '33333333-3333-4333-8333-333333333333'
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

const SPLIT_LAYOUT: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: FIRST_LEAF_ID },
    second: { type: 'leaf', leafId: SECOND_LEAF_ID }
  },
  activeLeafId: FIRST_LEAF_ID,
  expandedLeafId: null
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

  it('preserves an interrupted outcome for the destructive tab glyph', () => {
    const interrupted = entry(FIRST_LEAF_ID, 'done', { interrupted: true })
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: { [interrupted.paneKey]: interrupted },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('interrupted')
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

  it('attributes title-only activity to its provider', () => {
    expect(
      resolveTerminalTabActivityPresentation({
        tab: { id: TAB_ID, title: 'Codex working' },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toEqual({ status: 'working', agent: 'codex' })
  })

  it('attributes a working title to its sibling provider, not the focused provider', () => {
    expect(
      resolveTerminalTabActivityPresentation({
        tab: { id: TAB_ID, title: 'Codex ready' },
        runtimePaneTitlesByTabId: {
          [TAB_ID]: { 1: 'Codex ready', 2: 'OC | ⠋ implementing' }
        },
        ptyIdsByTabId: LIVE_PTY,
        terminalLayout: SPLIT_LAYOUT
      })
    ).toEqual({ status: 'working', agent: 'opencode' })
  })

  it('keeps same-priority mixed title providers neutral', () => {
    expect(
      resolveTerminalTabActivityPresentation({
        tab: { id: TAB_ID, title: 'Codex working' },
        runtimePaneTitlesByTabId: {
          [TAB_ID]: { 1: 'Codex working', 2: 'OC | ⠋ implementing' }
        },
        ptyIdsByTabId: LIVE_PTY,
        terminalLayout: SPLIT_LAYOUT
      })
    ).toEqual({ status: 'working', agent: null })
  })

  it('keeps an unknown title provider neutral without dropping its activity', () => {
    expect(
      resolveTerminalTabActivityPresentation({
        tab: { id: TAB_ID, title: 'mimo working' },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toEqual({ status: 'working', agent: null })
  })

  it('excludes a fresh hook-covered pane title from status and ownership', () => {
    const completedOpenCode = entry(SECOND_LEAF_ID, 'done', { agentType: 'opencode' })
    expect(
      resolveTerminalTabActivityPresentation({
        tab: { id: TAB_ID, title: 'Codex working' },
        agentStatusByPaneKey: { [completedOpenCode.paneKey]: completedOpenCode },
        runtimePaneTitlesByTabId: {
          [TAB_ID]: { 1: 'bash', 2: 'Codex working' }
        },
        ptyIdsByTabId: LIVE_PTY,
        terminalLayout: SPLIT_LAYOUT
      })
    ).toEqual({ status: 'done', agent: 'opencode' })
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

  it('preserves a blocked hook for the destructive tab glyph', () => {
    const blocked = entry(FIRST_LEAF_ID, 'blocked')
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: { [blocked.paneKey]: blocked },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('blocked')
  })

  it('lets blocked outrank waiting and working siblings', () => {
    const blocked = entry(FIRST_LEAF_ID, 'blocked')
    const waiting = entry(SECOND_LEAF_ID, 'waiting')
    const working = entry(THIRD_LEAF_ID, 'working')
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: {
          [blocked.paneKey]: blocked,
          [waiting.paneKey]: waiting,
          [working.paneKey]: working
        },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('blocked')
  })

  it('attributes a winning sibling state to that pane provider, not the focused provider', () => {
    const focusedCodex = entry(FIRST_LEAF_ID, 'working', { agentType: 'codex' })
    const siblingOpenCode = entry(SECOND_LEAF_ID, 'blocked', { agentType: 'opencode' })

    expect(
      resolveTerminalTabActivityPresentation({
        tab: TAB,
        agentStatusByPaneKey: {
          [focusedCodex.paneKey]: focusedCodex,
          [siblingOpenCode.paneKey]: siblingOpenCode
        },
        ptyIdsByTabId: LIVE_PTY,
        terminalLayout: SPLIT_LAYOUT
      })
    ).toEqual({ status: 'blocked', agent: 'opencode' })
  })

  it('uses a provider-neutral winning state when same-priority panes disagree', () => {
    const codex = entry(FIRST_LEAF_ID, 'blocked', { agentType: 'codex' })
    const openCode = entry(SECOND_LEAF_ID, 'blocked', { agentType: 'opencode' })

    expect(
      resolveTerminalTabActivityPresentation({
        tab: TAB,
        agentStatusByPaneKey: {
          [codex.paneKey]: codex,
          [openCode.paneKey]: openCode
        },
        ptyIdsByTabId: LIVE_PTY,
        terminalLayout: SPLIT_LAYOUT
      })
    ).toEqual({ status: 'blocked', agent: null })
  })

  it.each([
    ['working', 'working'],
    ['waiting', 'permission']
  ] as const)('lets a live %s sibling outrank an interrupted outcome', (state, expected) => {
    const interrupted = entry(FIRST_LEAF_ID, 'done', { interrupted: true })
    const live = entry(SECOND_LEAF_ID, state)
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: {
          [interrupted.paneKey]: interrupted,
          [live.paneKey]: live
        },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe(expected)
  })

  it('preserves interrupted when its only sibling is normally done', () => {
    const interrupted = entry(FIRST_LEAF_ID, 'done', { interrupted: true })
    const done = entry(SECOND_LEAF_ID, 'done')
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey: {
          [interrupted.paneKey]: interrupted,
          [done.paneKey]: done
        },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('interrupted')
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

describe('resolveTerminalTabUnreadActivity', () => {
  it('leaves generic unread ownership unspecified so the tab identity remains visible', () => {
    expect(
      resolveTerminalTabUnreadActivity({
        tabId: TAB_ID,
        hasUnreadTerminalTab: true
      })
    ).toEqual({ hasUnread: true, kind: 'terminal-activity', agent: undefined })
  })

  it('attributes an unread sibling completion to its pane provider', () => {
    const siblingOpenCode = entry(SECOND_LEAF_ID, 'done', { agentType: 'opencode' })

    expect(
      resolveTerminalTabUnreadActivity({
        tabId: TAB_ID,
        unreadAgentCompletionPanes: { [siblingOpenCode.paneKey]: true },
        agentStatusByPaneKey: { [siblingOpenCode.paneKey]: siblingOpenCode }
      })
    ).toEqual({ hasUnread: true, kind: 'agent-completion', agent: 'opencode' })
  })

  it('uses provider-neutral unread copy when completion panes disagree', () => {
    const codex = entry(FIRST_LEAF_ID, 'done', { agentType: 'codex' })
    const openCode = entry(SECOND_LEAF_ID, 'done', { agentType: 'opencode' })

    expect(
      resolveTerminalTabUnreadActivity({
        tabId: TAB_ID,
        unreadAgentCompletionPanes: {
          [codex.paneKey]: true,
          [openCode.paneKey]: true
        },
        agentStatusByPaneKey: {
          [codex.paneKey]: codex,
          [openCode.paneKey]: openCode
        }
      })
    ).toEqual({ hasUnread: true, kind: 'agent-completion', agent: null })
  })

  it('recovers exact unread provider identity from retained completion evidence', () => {
    const paneKey = `${TAB_ID}:${SECOND_LEAF_ID}`

    expect(
      resolveTerminalTabUnreadActivity({
        tabId: TAB_ID,
        unreadAgentCompletionPanes: { [paneKey]: true },
        retainedAgentsByPaneKey: {
          [paneKey]: { entry: { agentType: 'opencode' } }
        }
      })
    ).toEqual({ hasUnread: true, kind: 'agent-completion', agent: 'opencode' })
  })

  it('lets an agent completion outrank generic unread when both are present', () => {
    const completedOpenCode = entry(SECOND_LEAF_ID, 'done', { agentType: 'opencode' })

    expect(
      resolveTerminalTabUnreadActivity({
        tabId: TAB_ID,
        hasUnreadTerminalTab: true,
        unreadAgentCompletionPanes: { [completedOpenCode.paneKey]: true },
        agentStatusByPaneKey: { [completedOpenCode.paneKey]: completedOpenCode }
      })
    ).toEqual({ hasUnread: true, kind: 'agent-completion', agent: 'opencode' })
  })

  it('returns no unread kind or owner when the tab has no unread evidence', () => {
    expect(resolveTerminalTabUnreadActivity({ tabId: TAB_ID })).toEqual({
      hasUnread: false,
      kind: null,
      agent: undefined
    })
  })
})

describe('shouldShowTerminalTabUnreadActivity', () => {
  it('keeps generic terminal unread visible over a quiet tab', () => {
    const unread = resolveTerminalTabUnreadActivity({
      tabId: TAB_ID,
      hasUnreadTerminalTab: true
    })

    expect(
      shouldShowTerminalTabUnreadActivity({
        hasUnreadActivity: unread.hasUnread,
        unreadActivityKind: unread.kind,
        activityStatus: 'active',
        isEditing: false
      })
    ).toBe(true)
  })

  it('lets an explicit interruption outrank generic terminal unread', () => {
    const unread = resolveTerminalTabUnreadActivity({
      tabId: TAB_ID,
      hasUnreadTerminalTab: true
    })

    expect(
      shouldShowTerminalTabUnreadActivity({
        hasUnreadActivity: unread.hasUnread,
        unreadActivityKind: unread.kind,
        activityStatus: 'interrupted',
        isEditing: false
      })
    ).toBe(false)
  })

  it('keeps agent-completion unread visible over a successful done state', () => {
    const completed = entry(FIRST_LEAF_ID, 'done', { agentType: 'opencode' })
    const unread = resolveTerminalTabUnreadActivity({
      tabId: TAB_ID,
      unreadAgentCompletionPanes: { [completed.paneKey]: true },
      agentStatusByPaneKey: { [completed.paneKey]: completed }
    })

    expect(
      shouldShowTerminalTabUnreadActivity({
        hasUnreadActivity: unread.hasUnread,
        unreadActivityKind: unread.kind,
        activityStatus: 'done',
        isEditing: false
      })
    ).toBe(true)
  })

  it('shows a new interruption over unread completion from the prior turn', () => {
    const completed = entry(FIRST_LEAF_ID, 'done', { agentType: 'opencode' })
    const unreadFromPriorTurn = resolveTerminalTabUnreadActivity({
      tabId: TAB_ID,
      unreadAgentCompletionPanes: { [completed.paneKey]: true },
      agentStatusByPaneKey: { [completed.paneKey]: completed }
    })
    expect(
      shouldShowTerminalTabUnreadActivity({
        hasUnreadActivity: unreadFromPriorTurn.hasUnread,
        unreadActivityKind: unreadFromPriorTurn.kind,
        activityStatus: 'done',
        isEditing: false
      })
    ).toBe(true)

    const interruptedNextTurn = entry(FIRST_LEAF_ID, 'done', {
      agentType: 'opencode',
      interrupted: true
    })
    const latestStatus = resolveTerminalTabActivityStatus({
      tab: TAB,
      agentStatusByPaneKey: { [interruptedNextTurn.paneKey]: interruptedNextTurn },
      ptyIdsByTabId: LIVE_PTY
    })

    expect(latestStatus).toBe('interrupted')
    expect(
      shouldShowTerminalTabUnreadActivity({
        hasUnreadActivity: unreadFromPriorTurn.hasUnread,
        unreadActivityKind: unreadFromPriorTurn.kind,
        activityStatus: latestStatus,
        isEditing: false
      })
    ).toBe(false)
  })
})
