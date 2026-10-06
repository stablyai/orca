import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { createTestStore, makeWorktree, TEST_REPO } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/repo1'
const GROUP_ID = 'group-1'
const document: MarkdownDocument = {
  filePath: '/repo1/notes.md',
  relativePath: 'notes.md',
  basename: 'notes.md',
  name: 'notes'
}
const pickMarkdownDocument = vi.fn<() => Promise<MarkdownDocument | null>>()

function seededStore(worktreeId = WORKTREE_ID) {
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/repo1', hostId: 'local' })]
    },
    activeWorktreeId: worktreeId,
    activeWorkspaceExecutionHostId: 'local',
    groupsByWorktree: {
      [worktreeId]: [{ id: GROUP_ID, worktreeId, activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { [worktreeId]: GROUP_ID }
  })
  return store
}

describe('opening Markdown with a local workspace picker', () => {
  beforeEach(() => {
    pickMarkdownDocument.mockReset().mockResolvedValue(document)
    vi.stubGlobal('window', { api: { app: { pickMarkdownDocument } } })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('opens the selection permanently in the requested local split group', async () => {
    const store = seededStore()
    await store.getState().openMarkdownFileInWorkspace(WORKTREE_ID, GROUP_ID)

    expect(pickMarkdownDocument).toHaveBeenCalledWith('/repo1')
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: document.filePath,
        worktreeId: WORKTREE_ID,
        language: 'markdown',
        runtimeEnvironmentId: null,
        mode: 'edit',
        isPreview: undefined
      })
    ])
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ groupId: GROUP_ID, contentType: 'editor', isPreview: false })
    ])
  })

  it('roots the same picker at a folder workspace', async () => {
    const worktreeId = folderWorkspaceKey('folder-1')
    const store = seededStore(worktreeId)
    store.setState({
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'project-1',
          name: 'Notes',
          folderPath: '/notes',
          executionHostId: 'local',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    await store.getState().openMarkdownFileInWorkspace(worktreeId, GROUP_ID)

    expect(pickMarkdownDocument).toHaveBeenCalledWith('/notes')
    expect(store.getState().openFiles[0]?.worktreeId).toBe(worktreeId)
  })

  it.each(['ssh:remote', 'runtime:paired'] as const)(
    'does not invoke a local picker for %s',
    async (hostId) => {
      const store = seededStore()
      store.setState({ activeWorkspaceExecutionHostId: hostId })
      await store.getState().openMarkdownFileInWorkspace(WORKTREE_ID, GROUP_ID)
      expect(pickMarkdownDocument).not.toHaveBeenCalled()
      expect(store.getState().openFiles).toEqual([])
    }
  )

  it('does not offer a native picker to the paired web client', async () => {
    const store = seededStore()
    vi.stubGlobal('window', {
      __ORCA_WEB_CLIENT__: true,
      api: { app: { pickMarkdownDocument } }
    })
    await store.getState().openMarkdownFileInWorkspace(WORKTREE_ID, GROUP_ID)
    expect(pickMarkdownDocument).not.toHaveBeenCalled()
  })

  it('keeps the tabs unchanged when the chooser is canceled', async () => {
    const store = seededStore()
    pickMarkdownDocument.mockResolvedValue(null)
    await store.getState().openMarkdownFileInWorkspace(WORKTREE_ID, GROUP_ID)
    expect(store.getState().openFiles).toEqual([])
  })

  it.each(['workspace', 'owner', 'group', 'path'] as const)(
    'discards a chooser result after its %s changes',
    async (change) => {
      const store = seededStore()
      let complete: (value: MarkdownDocument) => void = () => {}
      pickMarkdownDocument.mockReturnValue(
        new Promise((resolve) => {
          complete = resolve
        })
      )
      const opening = store.getState().openMarkdownFileInWorkspace(WORKTREE_ID, GROUP_ID)
      expect(pickMarkdownDocument).toHaveBeenCalledTimes(1)
      if (change === 'workspace') {
        store.setState({ activeWorktreeId: 'other-workspace' })
      }
      if (change === 'owner') {
        store.setState({ activeWorkspaceExecutionHostId: 'ssh:remote' })
      }
      if (change === 'group') {
        store.setState({ groupsByWorktree: {} })
      }
      if (change === 'path') {
        store.setState({
          worktreesByRepo: {
            repo1: [
              makeWorktree({
                id: WORKTREE_ID,
                repoId: 'repo1',
                path: '/replacement',
                hostId: 'local'
              })
            ]
          }
        })
      }
      complete(document)
      await opening
      expect(store.getState().openFiles).toEqual([])
    }
  )
})
