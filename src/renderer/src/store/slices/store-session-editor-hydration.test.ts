import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createStoreSessionMockApi()

function ownedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeEnvironmentId?.trim() || 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

describe('hydrateEditorSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('restores edit-mode files from persisted session', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      // Why: hydrateEditorSession reads activeWorktreeId from the store (set by hydrateWorkspaceSession), not the raw session.
      activeWorktreeId: wt
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [
          {
            filePath: '/path/wt1/src/index.ts',
            relativePath: 'src/index.ts',
            worktreeId: wt,
            language: 'typescript'
          },
          {
            filePath: '/path/wt1/README.md',
            relativePath: 'README.md',
            worktreeId: wt,
            language: 'markdown',
            isPreview: true
          }
        ]
      },
      activeFileIdByWorktree: { [wt]: '/path/wt1/src/index.ts' },
      activeTabTypeByWorktree: { [wt]: 'editor' },
      markdownFrontmatterVisible: { '/path/wt1/README.md': false }
    })

    const s = store.getState()
    expect(s.openFiles).toHaveLength(2)
    expect(s.openFiles[0].filePath).toBe('/path/wt1/src/index.ts')
    expect(s.openFiles[0].mode).toBe('edit')
    expect(s.openFiles[0].isDirty).toBe(false)
    expect(s.openFiles[1].isPreview).toBe(true)
    expect(s.markdownFrontmatterVisible).toEqual({ '/path/wt1/README.md': false })
    expect(s.activeFileId).toBe('/path/wt1/src/index.ts')
    expect(s.activeTabType).toBe('editor')
  })

  it('restores floating workspace markdown files without a repo worktree', () => {
    const store = createTestStore()
    const filePath = '/orca/userData/floating-workspace/note.md'
    const fileId = ownedEditorFileId(filePath, FLOATING_TERMINAL_WORKTREE_ID, null)

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    store.getState().hydrateEditorSession({
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath,
            relativePath: 'note.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null,
            dirtyDraftContent: ''
          }
        ]
      },
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: '/orca/userData/floating-workspace/note.md'
      },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'editor' }
    })

    const s = store.getState()
    expect(s.openFiles).toEqual([
      expect.objectContaining({
        id: fileId,
        filePath,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        isDirty: true
      })
    ])
    expect(s.editorDrafts).toEqual({ [fileId]: '' })
    expect(s.markdownFrontmatterVisible).toEqual({})
    expect(s.activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(fileId)
  })

  it('migrates hydrated front-matter visibility to owner-qualified editor file ids', () => {
    const store = createTestStore()
    const filePath = '/orca/userData/floating-workspace/note.md'
    const fileId = ownedEditorFileId(filePath, FLOATING_TERMINAL_WORKTREE_ID, null)

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    store.getState().hydrateEditorSession({
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath,
            relativePath: 'note.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      },
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: filePath
      },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'editor' },
      markdownFrontmatterVisible: { [filePath]: false }
    })

    expect(store.getState().markdownFrontmatterVisible).toEqual({ [fileId]: false })
  })

  it('drops legacy visible=true front-matter entries so upgraded sessions fall back to the visible default', () => {
    const store = createTestStore()
    const filePath = '/orca/userData/floating-workspace/note.md'
    const fileId = ownedEditorFileId(filePath, FLOATING_TERMINAL_WORKTREE_ID, null)

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    store.getState().hydrateEditorSession({
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath,
            relativePath: 'note.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      },
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: filePath
      },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'editor' },
      // Pre-flip sessions stored `true` for the (then non-default) visible state.
      markdownFrontmatterVisible: { [filePath]: true }
    })

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
    expect(fileId in store.getState().markdownFrontmatterVisible).toBe(false)
  })

  it('falls back to the floating workspace file id when duplicate paths are owner-qualified', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const sharedPath = '/path/wt1/README.md'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [
          {
            filePath: sharedPath,
            relativePath: 'README.md',
            worktreeId: wt,
            language: 'markdown'
          }
        ],
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath: sharedPath,
            relativePath: 'README.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      },
      activeFileIdByWorktree: {
        [wt]: sharedPath,
        [FLOATING_TERMINAL_WORKTREE_ID]: sharedPath
      },
      activeTabTypeByWorktree: {
        [wt]: 'editor',
        [FLOATING_TERMINAL_WORKTREE_ID]: 'editor'
      }
    })

    const floatingActiveFileId =
      store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
    expect(floatingActiveFileId).not.toBe(sharedPath)
    expect(
      store
        .getState()
        .openFiles.some(
          (file) =>
            file.id === floatingActiveFileId && file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID
        )
    ).toBe(true)
  })

  it('keeps same-path local and runtime legacy references on their original owners', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const filePath = '/path/wt1/src/app.ts'
    const runtimeEnvironmentId = 'runtime-1'
    const runtimeFileId = ownedEditorFileId(filePath, wt, runtimeEnvironmentId)
    const groupId = 'group-same-path-owners'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })

    const session = {
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [
          {
            filePath,
            relativePath: 'src/app.ts',
            worktreeId: wt,
            language: 'typescript'
          },
          {
            filePath,
            relativePath: 'src/app.ts',
            worktreeId: wt,
            language: 'typescript',
            runtimeEnvironmentId
          }
        ]
      },
      activeFileIdByWorktree: { [wt]: filePath },
      activeTabTypeByWorktree: { [wt]: 'editor' as const },
      unifiedTabs: {
        [wt]: [
          {
            id: filePath,
            entityId: filePath,
            groupId,
            worktreeId: wt,
            contentType: 'editor' as const,
            label: 'app.ts',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: runtimeFileId,
            entityId: runtimeFileId,
            groupId,
            worktreeId: wt,
            contentType: 'editor' as const,
            label: 'app.ts',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        [wt]: [
          {
            id: groupId,
            worktreeId: wt,
            activeTabId: filePath,
            tabOrder: [filePath, runtimeFileId],
            recentTabIds: [runtimeFileId, filePath]
          }
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    }

    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)

    const s = store.getState()
    expect(s.openFiles).toEqual([
      expect.objectContaining({
        id: filePath,
        filePath,
        worktreeId: wt,
        runtimeEnvironmentId: undefined
      }),
      expect.objectContaining({
        id: runtimeFileId,
        filePath,
        worktreeId: wt,
        runtimeEnvironmentId
      })
    ])
    expect(s.activeFileIdByWorktree[wt]).toBe(filePath)
    expect(s.unifiedTabsByWorktree[wt]?.map((tab) => tab.id)).toEqual([filePath, runtimeFileId])
    expect(s.unifiedTabsByWorktree[wt]?.map((tab) => tab.entityId)).toEqual([
      filePath,
      runtimeFileId
    ])
    expect(s.groupsByWorktree[wt]?.[0]).toEqual(
      expect.objectContaining({
        activeTabId: filePath,
        tabOrder: [filePath, runtimeFileId],
        recentTabIds: [runtimeFileId, filePath]
      })
    )
  })

  it('drops a duplicate persisted file that would restore under an already used id', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const filePath = '/path/wt1/src/app.ts'
    const runtimeEnvironmentId = 'runtime-1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })

    const persistedFile = {
      filePath,
      relativePath: 'src/app.ts',
      worktreeId: wt,
      language: 'typescript',
      runtimeEnvironmentId
    }
    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      // The schema allows a repeated (path, worktree, runtime) tuple; both entries resolve to one owned id.
      openFilesByWorktree: { [wt]: [persistedFile, { ...persistedFile }] },
      activeFileIdByWorktree: {},
      activeTabTypeByWorktree: { [wt]: 'editor' as const }
    })

    const s = store.getState()
    expect(s.openFiles.map((file) => file.id)).toEqual([
      ownedEditorFileId(filePath, wt, runtimeEnvironmentId)
    ])
  })

  it('keeps floating owner-qualified editor ids aligned with restored unified tabs', () => {
    const store = createTestStore()
    const sharedPath = '/path/wt1/README.md'
    const floatingFileId = ownedEditorFileId(sharedPath, FLOATING_TERMINAL_WORKTREE_ID, null)
    const groupId = 'floating-group-1'

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    const session = {
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath: sharedPath,
            relativePath: 'README.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      },
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: floatingFileId
      },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'editor' as const },
      unifiedTabs: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: floatingFileId,
            entityId: floatingFileId,
            groupId,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            contentType: 'editor' as const,
            label: 'README.md',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: groupId,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: floatingFileId,
            tabOrder: [floatingFileId],
            recentTabIds: [floatingFileId]
          }
        ]
      },
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: groupId }
    }

    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)

    const s = store.getState()
    expect(s.openFiles).toEqual([
      expect.objectContaining({
        id: floatingFileId,
        filePath: sharedPath,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      })
    ])
    expect(s.activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(floatingFileId)
    expect(s.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([
      expect.objectContaining({
        id: floatingFileId,
        entityId: floatingFileId
      })
    ])
    expect(s.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([
      expect.objectContaining({
        activeTabId: floatingFileId,
        tabOrder: [floatingFileId],
        recentTabIds: [floatingFileId]
      })
    ])
  })

  it('migrates legacy floating unified tab file-path references to the hydrated owner id', () => {
    const store = createTestStore()
    const filePath = '/orca/userData/floating-workspace/README.md'
    const fileId = ownedEditorFileId(filePath, FLOATING_TERMINAL_WORKTREE_ID, null)
    const groupId = 'floating-group-legacy'

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    const session = {
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath,
            relativePath: 'README.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      },
      activeFileIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: filePath },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'editor' as const },
      unifiedTabs: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: filePath,
            entityId: filePath,
            groupId,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            contentType: 'editor' as const,
            label: 'README.md',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: groupId,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: filePath,
            tabOrder: [filePath],
            recentTabIds: [filePath]
          }
        ]
      },
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: groupId }
    }

    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)

    const s = store.getState()
    expect(s.openFiles[0]?.id).toBe(fileId)
    expect(s.activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(fileId)
    expect(s.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]).toEqual(
      expect.objectContaining({ id: fileId, entityId: fileId })
    )
    expect(s.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]).toEqual(
      expect.objectContaining({
        activeTabId: fileId,
        tabOrder: [fileId],
        recentTabIds: [fileId]
      })
    )
  })

  it('re-detects restored file languages instead of trusting stale session data', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [
          {
            filePath: '/path/wt1/notebooks/example.ipynb',
            relativePath: 'notebooks/example.ipynb',
            worktreeId: wt,
            language: 'json'
          }
        ]
      },
      activeFileIdByWorktree: { [wt]: '/path/wt1/notebooks/example.ipynb' },
      activeTabTypeByWorktree: { [wt]: 'editor' }
    })

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        filePath: '/path/wt1/notebooks/example.ipynb',
        language: 'notebook'
      })
    )
  })

  it('does nothing when no editor files are persisted', () => {
    const store = createTestStore()

    store.getState().hydrateEditorSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    })

    const s = store.getState()
    expect(s.openFiles).toHaveLength(0)
    expect(s.activeFileId).toBeNull()
    expect(s.activeTabType).toBe('terminal')
  })

  it('clears stale editor markers when no edit-mode files restore for the active worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'editor'
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      activeFileIdByWorktree: { [wt]: `${wt}::diff::unstaged::src/index.ts` },
      activeTabTypeByWorktree: { [wt]: 'editor' }
    })

    const s = store.getState()
    expect(s.openFiles).toHaveLength(0)
    expect(s.activeFileId).toBeNull()
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeFileIdByWorktree[wt]).toBeUndefined()
    expect(s.activeTabTypeByWorktree[wt]).toBeUndefined()
  })

  it('promotes the first restored edit file if persisted activeFileId is missing', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [
          {
            filePath: '/path/wt1/src/index.ts',
            relativePath: 'src/index.ts',
            worktreeId: wt,
            language: 'typescript'
          }
        ]
      },
      // Points to a file that no longer exists in the restored set
      activeFileIdByWorktree: { [wt]: '/path/wt1/gone.ts' },
      activeTabTypeByWorktree: { [wt]: 'editor' }
    })

    const s = store.getState()
    expect(s.openFiles).toHaveLength(1)
    expect(s.activeFileId).toBe('/path/wt1/src/index.ts')
    expect(s.activeTabType).toBe('editor')
    expect(s.activeFileIdByWorktree[wt]).toBe('/path/wt1/src/index.ts')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
  })

  it('filters out files for deleted worktrees', () => {
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'
    const deletedWt = 'repo1::/path/gone'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: validWt
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: validWt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [validWt]: [
          {
            filePath: '/path/wt1/src/index.ts',
            relativePath: 'src/index.ts',
            worktreeId: validWt,
            language: 'typescript'
          }
        ],
        [deletedWt]: [
          {
            filePath: '/path/gone/src/app.ts',
            relativePath: 'src/app.ts',
            worktreeId: deletedWt,
            language: 'typescript'
          }
        ]
      },
      activeFileIdByWorktree: {
        [validWt]: '/path/wt1/src/index.ts',
        [deletedWt]: '/path/gone/src/app.ts'
      },
      activeTabTypeByWorktree: { [validWt]: 'editor', [deletedWt]: 'editor' }
    })

    const s = store.getState()
    // Only files from the valid worktree should be restored
    expect(s.openFiles).toHaveLength(1)
    expect(s.openFiles[0].worktreeId).toBe(validWt)
    // Deleted worktree should not appear in per-worktree maps
    expect(s.activeFileIdByWorktree[deletedWt]).toBeUndefined()
    expect(s.activeTabTypeByWorktree[deletedWt]).toBeUndefined()
  })
})
