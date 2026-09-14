import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { DashboardAgentRow } from './useDashboardData'
import { resolveDashboardCardSurface } from './dashboard-card-surface'

const TAB_ID = 'session-tab'
const SESSION_ID = 'session-1'

function structuredTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: TAB_ID,
    entityId: SESSION_ID,
    groupId: 'group-1',
    worktreeId: 'worktree-1',
    contentType: 'agent-session',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPinned: false,
    agentSessionAgent: 'codex',
    ...overrides
  }
}

function row(
  overrides: Partial<DashboardAgentRow['entry']> = {}
): Pick<DashboardAgentRow, 'entry'> {
  return {
    entry: {
      paneKey: 'session-tab:leaf-1',
      state: 'done',
      prompt: 'hello',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      agentType: 'codex',
      tabId: TAB_ID,
      worktreeId: 'worktree-1',
      ...overrides
    }
  }
}

describe('resolveDashboardCardSurface', () => {
  it('classifies a unified agent-session tab as structured chat', () => {
    expect(
      resolveDashboardCardSurface({
        row: row(),
        tabId: TAB_ID,
        unifiedTabs: [structuredTab()]
      })
    ).toEqual({
      surfaceKind: 'structured-chat',
      structuredSessionId: SESSION_ID
    })
  })

  it('classifies a host-owned structured feed without inventing a session id', () => {
    expect(
      resolveDashboardCardSurface({
        row: row({ structuredHostOwned: true }),
        tabId: TAB_ID,
        unifiedTabs: []
      })
    ).toEqual({ surfaceKind: 'structured-chat' })
  })

  it('leaves terminal-backed rows unclassified', () => {
    expect(
      resolveDashboardCardSurface({
        row: row(),
        tabId: TAB_ID,
        unifiedTabs: [
          structuredTab({
            id: 'other-tab',
            contentType: 'terminal',
            entityId: 'pty-1'
          })
        ]
      })
    ).toEqual({})
  })
})
