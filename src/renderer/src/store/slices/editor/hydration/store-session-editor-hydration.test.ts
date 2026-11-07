import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import { createStoreSessionMockApi } from '../../../testing/app-store-session-api.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

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
})
