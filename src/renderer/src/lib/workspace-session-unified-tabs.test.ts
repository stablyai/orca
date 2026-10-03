import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WORKTREE_ID = 'repo-1::/x'

function editorTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    entityId: '/x/README.md',
    groupId: 'group-1',
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: 'README.md',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

describe('buildPersistedUnifiedTabSessionData', () => {
  it('writes one record for repeated tab ids', () => {
    const persisted = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [editorTab(), editorTab()] },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'group-1', worktreeId: WORKTREE_ID, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
        ]
      },
      layoutByWorktree: {},
      activeGroupIdByWorktree: {}
    })

    expect(persisted.unifiedTabs?.[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(persisted.tabGroups?.[WORKTREE_ID]?.[0]?.tabOrder).toEqual(['tab-1'])
  })

  it('keeps the copy hydration would keep when one tab id spans two groups', () => {
    const stale = editorTab({
      groupId: 'group-1',
      sortOrder: 9,
      customLabel: 'stale',
      isPinned: false
    })
    const chosen = editorTab({
      groupId: 'group-2',
      sortOrder: 0,
      customLabel: 'chosen',
      isPinned: true
    })
    const persisted = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [stale, chosen] },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'group-1', worktreeId: WORKTREE_ID, activeTabId: 'tab-1', tabOrder: ['tab-1'] },
          { id: 'group-2', worktreeId: WORKTREE_ID, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
        ]
      },
      layoutByWorktree: {},
      activeGroupIdByWorktree: {}
    })

    expect(persisted.unifiedTabs?.[WORKTREE_ID]).toEqual([chosen])

    const store = createTestStore()
    store.setState({
      repos: [{ id: 'repo-1', path: '/x', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/x' })]
      }
    })
    const session: WorkspaceSessionState = {
      activeRepoId: 'repo-1',
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...persisted
    }
    store.getState().hydrateTabsSession(session)

    const hydrated = store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []
    expect(hydrated.map((tab) => [tab.id, tab.groupId, tab.customLabel, tab.isPinned])).toEqual([
      ['tab-1', 'group-2', 'chosen', true]
    ])
  })
})
