import { describe, expect, it } from 'vitest'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { DashboardAgentRow } from './useDashboardData'
import { resolveDashboardCardSurface } from './dashboard-card-surface'

const TAB_ID = 'session-tab'
const SESSION_ID = 'session-1'
const HOST_OWNED_TAB_ID = structuredAgentSessionTabId(SESSION_ID)

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

  it('recovers the session id from a host-owned structured tab id', () => {
    expect(
      resolveDashboardCardSurface({
        row: row({ structuredHostOwned: true, tabId: HOST_OWNED_TAB_ID }),
        tabId: HOST_OWNED_TAB_ID,
        unifiedTabs: []
      })
    ).toEqual({
      surfaceKind: 'structured-chat',
      structuredSessionId: SESSION_ID
    })
  })

  it('does not invent a session id for host-owned rows with a non-canonical tab id', () => {
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
            id: TAB_ID,
            contentType: 'terminal',
            entityId: 'pty-1'
          })
        ]
      })
    ).toEqual({})
  })
})
