import { describe, expect, it } from 'vitest'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveOpenTabOccupantAgent } from './open-tab-occupant-agent'

const TAB_ID = 'tab-1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function layout(activeLeafId: string | null): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: LEAF_A },
      second: { type: 'leaf', leafId: LEAF_B }
    },
    activeLeafId,
    expandedLeafId: null
  }
}

function status(
  leafId: string,
  agentType: TuiAgent,
  state: AgentStatusEntry['state'] = 'working'
): AgentStatusEntry {
  const paneKey = makePaneKey(TAB_ID, leafId)
  return {
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey,
    tabId: TAB_ID,
    worktreeId: 'wt-1',
    stateHistory: [],
    agentType
  }
}

function sleeping(leafId: string, agent: TuiAgent): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey(TAB_ID, leafId),
    tabId: TAB_ID,
    worktreeId: 'wt-1',
    agent: agent as SleepingAgentSessionRecord['agent'],
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: '',
    state: 'waiting',
    capturedAt: 1,
    updatedAt: 1
  }
}

function retained(leafId: string, agentType: TuiAgent): RetainedAgentEntry {
  const entry = status(leafId, agentType, 'done')
  return {
    entry,
    worktreeId: 'wt-1',
    tab: { id: TAB_ID, title: 'done' } as TerminalTab,
    agentType,
    startedAt: 1
  }
}

function resolve(
  overrides: Partial<Parameters<typeof resolveOpenTabOccupantAgent>[0]> = {}
): TuiAgent | null {
  return resolveOpenTabOccupantAgent({
    tabId: TAB_ID,
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    ...overrides
  })
}

describe('resolveOpenTabOccupantAgent', () => {
  it('uses launchAgent when no hook or sleeping record exists', () => {
    expect(resolve({ launchAgent: 'grok' })).toBe('grok')
  })

  it('prefers a live focused hook over launchAgent', () => {
    expect(
      resolve({
        launchAgent: 'grok',
        layout: layout(LEAF_A),
        agentStatusByPaneKey: {
          [makePaneKey(TAB_ID, LEAF_A)]: status(LEAF_A, 'claude'),
          [makePaneKey(TAB_ID, LEAF_B)]: status(LEAF_B, 'grok')
        }
      })
    ).toBe('claude')
  })

  it('uses the focused split leaf, not insertion order', () => {
    expect(
      resolve({
        layout: layout(LEAF_B),
        agentStatusByPaneKey: {
          [makePaneKey(TAB_ID, LEAF_A)]: status(LEAF_A, 'claude'),
          [makePaneKey(TAB_ID, LEAF_B)]: status(LEAF_B, 'grok')
        }
      })
    ).toBe('grok')
  })

  it('uses the tab-strip title identity when hooks have not reported yet', () => {
    expect(resolve({ title: 'grok' })).toBe('grok')
  })

  it('does not let a grok mention in the title steal a launched Claude pane', () => {
    expect(
      resolve({
        launchAgent: 'claude',
        title: 'fix grok parser'
      })
    ).toBe('claude')
  })

  it('does not treat a hyphenated grok mention as occupancy', () => {
    expect(resolve({ title: 'session-scanner-grok-parser' })).toBeNull()
  })

  it('uses the focused sleeping session, matching useTabAgent', () => {
    expect(
      resolve({
        layout: layout(LEAF_A),
        sleepingAgentSessionsByPaneKey: {
          [makePaneKey(TAB_ID, LEAF_A)]: sleeping(LEAF_A, 'grok'),
          [makePaneKey(TAB_ID, LEAF_B)]: sleeping(LEAF_B, 'claude')
        }
      })
    ).toBe('grok')
  })

  it('does not invent a sibling sleeping occupant when the focused leaf has none', () => {
    expect(
      resolve({
        layout: layout(LEAF_A),
        sleepingAgentSessionsByPaneKey: {
          [makePaneKey(TAB_ID, LEAF_B)]: sleeping(LEAF_B, 'grok')
        }
      })
    ).toBeNull()
  })

  it('falls back to a completed focused hook after launchAgent is gone', () => {
    expect(
      resolve({
        layout: layout(LEAF_A),
        agentStatusByPaneKey: {
          [makePaneKey(TAB_ID, LEAF_A)]: status(LEAF_A, 'grok', 'done')
        }
      })
    ).toBe('grok')
  })

  it('falls back to a retained completion when live status is gone', () => {
    expect(
      resolve({
        layout: layout(LEAF_A),
        retainedAgentsByPaneKey: {
          [makePaneKey(TAB_ID, LEAF_A)]: retained(LEAF_A, 'codex')
        }
      })
    ).toBe('codex')
  })

  it('uses a live sibling when the focused pane is a shell', () => {
    expect(
      resolve({
        layout: layout(LEAF_A),
        agentStatusByPaneKey: {
          [makePaneKey(TAB_ID, LEAF_B)]: status(LEAF_B, 'grok')
        }
      })
    ).toBe('grok')
  })

  it('ignores a live hook that belongs to another tab', () => {
    expect(
      resolve({
        launchAgent: undefined,
        agentStatusByPaneKey: {
          [makePaneKey('tab-other', LEAF_A)]: {
            ...status(LEAF_A, 'grok'),
            tabId: 'tab-other',
            paneKey: makePaneKey('tab-other', LEAF_A)
          }
        }
      })
    ).toBeNull()
  })
})
