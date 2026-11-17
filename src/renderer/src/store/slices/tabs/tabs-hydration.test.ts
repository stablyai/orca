import { describe, expect, it } from 'vitest'
import { emptySession } from '../../../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import { buildHydratedTabState } from './tabs-hydration'

const WORKSPACE = 'repo::/repo'

function row(id: string, sortOrder: number, ptyId: string | null = null) {
  return {
    id,
    ptyId,
    worktreeId: WORKSPACE,
    title: `Shell ${sortOrder}`,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

describe('buildHydratedTabState', () => {
  it('restores saved terminals the tab bar never listed, in their saved order', () => {
    const session = emptySession()
    session.tabsByWorktree = { [WORKSPACE]: [row('tab-b', 1), row('tab-a', 0)] }
    session.unifiedTabs = { [WORKSPACE]: [] }

    const hydrated = buildHydratedTabState(session, new Set([WORKSPACE]))

    expect(hydrated.unifiedTabsByWorktree[WORKSPACE]?.map((tab) => tab.label)).toEqual([
      'Shell 0',
      'Shell 1'
    ])
    expect(hydrated.groupsByWorktree[WORKSPACE]?.map((group) => group.tabOrder)).toEqual([
      ['tab-a', 'tab-b']
    ])
  })

  it('keeps a stale row out when a listed tab already holds its terminal', () => {
    const session = emptySession()
    session.tabsByWorktree = {
      [WORKSPACE]: [row('tab-live', 0, 'pty-1'), row('tab-stale', 1, 'pty-1')]
    }
    session.unifiedTabs = {
      [WORKSPACE]: [
        {
          id: 'tab-live',
          entityId: 'tab-live',
          groupId: 'group-1',
          worktreeId: WORKSPACE,
          contentType: 'terminal',
          label: 'Shell 0',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    session.tabGroups = {
      [WORKSPACE]: [
        {
          id: 'group-1',
          worktreeId: WORKSPACE,
          activeTabId: 'tab-live',
          tabOrder: ['tab-live']
        }
      ]
    }

    const hydrated = buildHydratedTabState(session, new Set([WORKSPACE]))

    expect(hydrated.groupsByWorktree[WORKSPACE]?.map((group) => group.tabOrder)).toEqual([
      ['tab-live']
    ])
  })
})
