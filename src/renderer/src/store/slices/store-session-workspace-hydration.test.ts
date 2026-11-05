import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore, makeTab, makeLayout } from './store-test-helpers'
import { createStoreSessionMockApi, makeBrowserTab } from './store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createStoreSessionMockApi()

function makeDetectedWorktreeResult(
  repoId: string,
  worktrees: Worktree[],
  authoritative = true
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative,
    source: authoritative ? 'git' : 'metadata-fallback',
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed',
      selectedCheckout: false,
      visible: true
    }))
  }
}

describe('hydrateWorkspaceSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves tabs for a known repo after a non-authoritative worktree fetch', () => {
    // Why (#1158): metadata fallback means the runtime did not prove deletion.
    const store = createTestStore()
    const stalledWt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: {
        repo1: makeDetectedWorktreeResult('repo1', [], false)
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: stalledWt,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [stalledWt]: [makeTab({ id: 'tab1', worktreeId: stalledWt })]
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout()
      }
    })

    const s = store.getState()
    expect(s.tabsByWorktree[stalledWt]).toHaveLength(1)
    expect(s.terminalLayoutsByTabId['tab1']).toBeDefined()
    expect(s.activeWorktreeId).toBe(stalledWt)
    expect(s.activeTabId).toBe('tab1')
  })

  it('drops tabs when an authoritative scan reports no matching worktrees', () => {
    // Why: once git answers authoritatively, an empty repo list means deleted local worktrees, not a startup race.
    const store = createTestStore()
    const staleWt = 'repo1::/path/deleted'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: {
        repo1: makeDetectedWorktreeResult('repo1', [])
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: staleWt,
      activeTabId: 'tab-stale',
      tabsByWorktree: {
        [staleWt]: [makeTab({ id: 'tab-stale', worktreeId: staleWt })]
      },
      terminalLayoutsByTabId: {
        'tab-stale': makeLayout()
      }
    })

    const s = store.getState()
    expect(s.tabsByWorktree[staleWt]).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab-stale']).toBeUndefined()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeTabId).toBeNull()
  })
})

describe('restored folder workspace hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps runtime folder workspace tabs, files, and browsers before remote catalogs load', () => {
    const store = createTestStore()
    const folderKey = folderWorkspaceKey('remote-folder')
    const groupId = 'group-folder'
    const editorFileId = '/srv/app/src/App.tsx'
    const session = {
      ...getDefaultWorkspaceSession(),
      activeWorkspaceKey: folderKey,
      activeWorktreeId: folderKey,
      activeTabId: 'terminal-folder',
      tabsByWorktree: {
        [folderKey]: [makeTab({ id: 'terminal-folder', worktreeId: folderKey })]
      },
      openFilesByWorktree: {
        [folderKey]: [
          {
            filePath: editorFileId,
            relativePath: 'src/App.tsx',
            worktreeId: folderKey,
            language: 'typescript'
          }
        ]
      },
      activeFileIdByWorktree: { [folderKey]: editorFileId },
      browserTabsByWorktree: {
        [folderKey]: [
          makeBrowserTab({
            id: 'browser-folder',
            worktreeId: folderKey,
            url: 'https://example.com'
          })
        ]
      },
      browserPagesByWorkspace: {
        'browser-folder': [
          {
            id: 'browser-page-folder',
            workspaceId: 'browser-folder',
            worktreeId: folderKey,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [folderKey]: 'browser-folder' },
      activeTabTypeByWorktree: { [folderKey]: 'browser' as const },
      unifiedTabs: {
        [folderKey]: [
          {
            id: 'terminal-folder',
            entityId: 'terminal-folder',
            groupId,
            worktreeId: folderKey,
            contentType: 'terminal' as const,
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: editorFileId,
            entityId: editorFileId,
            groupId,
            worktreeId: folderKey,
            contentType: 'editor' as const,
            label: 'App.tsx',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          },
          {
            id: 'browser-folder',
            entityId: 'browser-folder',
            groupId,
            worktreeId: folderKey,
            contentType: 'browser' as const,
            label: 'Example',
            customLabel: null,
            color: null,
            sortOrder: 2,
            createdAt: 3
          }
        ]
      },
      tabGroups: {
        [folderKey]: [
          {
            id: groupId,
            worktreeId: folderKey,
            activeTabId: 'browser-folder',
            tabOrder: ['terminal-folder', editorFileId, 'browser-folder'],
            recentTabIds: ['terminal-folder', editorFileId, 'browser-folder']
          }
        ]
      },
      activeGroupIdByWorktree: { [folderKey]: groupId }
    }
    const options = {
      additionalValidWorkspaceKeys: [folderKey],
      runtimeHostIdByWorkspaceSessionKey: { [folderKey]: 'runtime:env-1' as const }
    }

    store.getState().hydrateWorkspaceSession(session, options)
    store.getState().hydrateTabsSession(session, options)
    store.getState().hydrateEditorSession(session, options)
    store.getState().hydrateBrowserSession(session, options)

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(folderKey)
    expect(state.activeWorkspaceKey).toBe(folderKey)
    expect(state.tabsByWorktree[folderKey]?.map((tab) => tab.id)).toEqual(['terminal-folder'])
    expect(state.unifiedTabsByWorktree[folderKey]?.map((tab) => tab.id)).toEqual([
      'terminal-folder',
      editorFileId,
      'browser-folder'
    ])
    expect(state.openFiles.map((file) => file.worktreeId)).toEqual([folderKey])
    expect(state.activeFileIdByWorktree[folderKey]).toBe(editorFileId)
    expect(state.browserTabsByWorktree[folderKey]?.map((tab) => tab.id)).toEqual(['browser-folder'])
    expect(state.browserPagesByWorkspace['browser-folder']?.[0]?.worktreeId).toBe(folderKey)
    expect(state.activeTabTypeByWorktree[folderKey]).toBe('browser')
  })
})
