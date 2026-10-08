/**
 * A host with no window writes editor tabs into the workspace session in the window's own format.
 * A window that attaches later must restore them with the same tab ids (no duplicate, none
 * dropped), so a phone keeps addressing the same tabs across the handoff.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WT = 'repo1::/path/wt1'
const NOTE = '/path/wt1/notes.md'
const HOST_TAB_ID = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

function storeWithWorktree() {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  return store
}

const baseSession: WorkspaceSessionState = {
  activeRepoId: 'repo1',
  activeWorktreeId: WT,
  activeTabId: 'term-1',
  tabsByWorktree: {
    [WT]: [
      {
        id: 'term-1',
        ptyId: null,
        worktreeId: WT,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  },
  terminalLayoutsByTabId: {},
  openFilesByWorktree: {
    [WT]: [{ filePath: NOTE, relativePath: 'notes.md', worktreeId: WT, language: 'markdown' }]
  },
  activeFileIdByWorktree: { [WT]: NOTE },
  activeTabTypeByWorktree: { [WT]: 'editor' }
}

describe('window hydration of host-written editor tabs', () => {
  it('keeps the host wrapper id and its group in a unified session', () => {
    const store = storeWithWorktree()
    const session: WorkspaceSessionState = {
      ...baseSession,
      unifiedTabs: {
        [WT]: [
          {
            id: 'term-1',
            entityId: 'term-1',
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'terminal',
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          // Exactly the wrapper the host writes for a new edit tab.
          {
            id: HOST_TAB_ID,
            entityId: NOTE,
            groupId: 'g-2',
            worktreeId: WT,
            executionHostId: 'local',
            contentType: 'editor',
            label: 'notes.md',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        [WT]: [
          { id: 'g-1', worktreeId: WT, activeTabId: 'term-1', tabOrder: ['term-1'] },
          {
            id: 'g-2',
            worktreeId: WT,
            activeTabId: HOST_TAB_ID,
            tabOrder: [HOST_TAB_ID],
            recentTabIds: [HOST_TAB_ID]
          }
        ]
      },
      tabGroupLayouts: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'g-1' },
          second: { type: 'leaf', groupId: 'g-2' }
        }
      },
      activeGroupIdByWorktree: { [WT]: 'g-2' }
    }

    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)

    const state = store.getState()
    const editorTabs = state.unifiedTabsByWorktree[WT]!.filter(
      (tab) => tab.contentType === 'editor'
    )
    expect(editorTabs).toEqual([
      expect.objectContaining({ id: HOST_TAB_ID, entityId: NOTE, groupId: 'g-2' })
    ])
    expect(state.openFiles.map((file) => file.id)).toEqual([NOTE])
    expect(state.groupsByWorktree[WT]?.find((group) => group.id === 'g-2')?.tabOrder).toEqual([
      HOST_TAB_ID
    ])
    expect(state.activeGroupIdByWorktree[WT]).toBe('g-2')
  })

  it('restores an editor the host moved out of a persisted headless terminal group', () => {
    const store = storeWithWorktree()
    const headlessGroupId = `headless-terminals:${WT}`
    const editorWrapper = {
      id: HOST_TAB_ID,
      entityId: NOTE,
      groupId: 'g-2',
      worktreeId: WT,
      contentType: 'editor' as const,
      label: 'notes.md',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 2
    }
    // What the host writes after a phone moves notes.md into the right-hand group.
    const session: WorkspaceSessionState = {
      ...baseSession,
      unifiedTabs: {
        [WT]: [
          {
            ...editorWrapper,
            id: 'term-1',
            entityId: 'term-1',
            groupId: headlessGroupId,
            contentType: 'terminal'
          },
          editorWrapper
        ]
      },
      tabGroups: {
        [WT]: [
          { id: headlessGroupId, worktreeId: WT, activeTabId: 'term-1', tabOrder: ['term-1'] },
          { id: 'g-2', worktreeId: WT, activeTabId: HOST_TAB_ID, tabOrder: [HOST_TAB_ID] }
        ]
      },
      tabGroupLayouts: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: headlessGroupId },
          second: { type: 'leaf', groupId: 'g-2' }
        }
      },
      activeGroupIdByWorktree: { [WT]: 'g-2' }
    }

    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)

    const state = store.getState()
    expect(
      state.unifiedTabsByWorktree[WT]!.find((tab) => tab.contentType === 'editor')?.groupId
    ).toBe('g-2')
    expect(state.groupsByWorktree[WT]?.find((group) => group.id === 'g-2')?.tabOrder).toEqual([
      HOST_TAB_ID
    ])
  })

  it('names the tab by its path in a legacy session, as the host publishes it', () => {
    const store = storeWithWorktree()

    store.getState().hydrateTabsSession(baseSession)
    store.getState().hydrateEditorSession(baseSession)

    const editorTabs = store
      .getState()
      .unifiedTabsByWorktree[WT]!.filter((tab) => tab.contentType === 'editor')
    expect(editorTabs.map((tab) => tab.id)).toEqual([NOTE])
    expect(store.getState().openFiles.map((file) => file.id)).toEqual([NOTE])
  })
})
