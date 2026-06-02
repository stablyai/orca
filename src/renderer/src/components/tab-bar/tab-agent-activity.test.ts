import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import { getTabAgentActivity } from './tab-agent-activity'

const NOW = 1_800_000
const FIRST_LEAF_ID = '00000000-0000-4000-8000-000000000001'
const SECOND_LEAF_ID = '00000000-0000-4000-8000-000000000002'

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeStatus(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'Implement tab badge',
    updatedAt: NOW,
    stateStartedAt: NOW,
    agentType: 'codex',
    paneKey: 'tab-1:00000000-0000-4000-8000-000000000001',
    stateHistory: [],
    ...overrides
  }
}

function getActivity(
  overrides: Partial<Parameters<typeof getTabAgentActivity>[0]> = {}
): ReturnType<typeof getTabAgentActivity> {
  return getTabAgentActivity({
    tab: makeTab(),
    agentStatusByPaneKey: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    now: NOW,
    ...overrides
  })
}

describe('getTabAgentActivity', () => {
  it('uses fresh explicit hook status before terminal liveness', () => {
    expect(
      getActivity({
        agentStatusByPaneKey: {
          'tab-1:00000000-0000-4000-8000-000000000001': makeStatus()
        }
      })
    ).toBe('working')
  })

  it('accepts legacy numeric pane keys from restored status entries', () => {
    expect(
      getActivity({
        agentStatusByPaneKey: {
          'tab-1:0': makeStatus({ paneKey: 'tab-1:0' })
        }
      })
    ).toBe('working')
  })

  it('lets a fresh non-working hook status suppress a stale working title', () => {
    expect(
      getActivity({
        tab: makeTab({ title: 'Codex working' }),
        agentStatusByPaneKey: {
          'tab-1:00000000-0000-4000-8000-000000000001': makeStatus({ state: 'done' })
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] }
      })
    ).toBeNull()
  })

  it('lets a fresh non-working hook status suppress the matching runtime pane title', () => {
    expect(
      getActivity({
        agentStatusByPaneKey: {
          [`tab-1:${FIRST_LEAF_ID}`]: makeStatus({
            state: 'done',
            paneKey: `tab-1:${FIRST_LEAF_ID}`
          })
        },
        runtimePaneTitlesByTabId: { 'tab-1': { 1: 'Codex working' } },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: FIRST_LEAF_ID },
            activeLeafId: FIRST_LEAF_ID,
            expandedLeafId: null
          }
        }
      })
    ).toBeNull()
  })

  it('uses hookless split-pane runtime titles when another pane has a fresh hook status', () => {
    expect(
      getActivity({
        agentStatusByPaneKey: {
          [`tab-1:${FIRST_LEAF_ID}`]: makeStatus({
            state: 'done',
            paneKey: `tab-1:${FIRST_LEAF_ID}`
          })
        },
        runtimePaneTitlesByTabId: { 'tab-1': { 1: 'Codex done', 2: 'Claude working' } },
        ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: FIRST_LEAF_ID },
              second: { type: 'leaf', leafId: SECOND_LEAF_ID }
            },
            activeLeafId: FIRST_LEAF_ID,
            expandedLeafId: null
          }
        }
      })
    ).toBe('working')
  })

  it('falls back to a live tab title when explicit status is stale', () => {
    expect(
      getActivity({
        tab: makeTab({ title: 'Codex working' }),
        agentStatusByPaneKey: {
          'tab-1:00000000-0000-4000-8000-000000000001': makeStatus({
            updatedAt: NOW - 30 * 60 * 1000 - 1
          })
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] }
      })
    ).toBe('working')
  })

  it('does not trust title-derived activity without a live PTY', () => {
    expect(getActivity({ tab: makeTab({ title: 'Codex working' }) })).toBeNull()
  })

  it('uses split-pane runtime titles when they are available', () => {
    expect(
      getActivity({
        runtimePaneTitlesByTabId: { 'tab-1': { 0: 'zsh', 1: 'Claude working' } },
        ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] }
      })
    ).toBe('working')
  })
})
