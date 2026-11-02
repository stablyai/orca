import { beforeEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeFolderWorkspace, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

beforeEach(resetWorktreeSliceModuleMemory)

// With the switch on, the owning host writes every Recent stamp; the window writes none.
describe('window-side Recent stamps with the sidebar-inputs switch on', () => {
  const wt = makeWorktree({
    id: 'repo1::/path/wt1',
    repoId: 'repo1',
    path: '/path/wt1',
    lastActivityAt: 5
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  function storeWith() {
    const store = createTestStore()
    store.setState({ worktreesByRepo: { repo1: [wt] } })
    return store
  }

  const lastActivityAt = (store: ReturnType<typeof createTestStore>) =>
    store.getState().worktreesByRepo.repo1[0].lastActivityAt

  const persistedStamp = () =>
    mockApi.worktrees.updateMeta.mock.calls.some(
      ([args]: [{ updates: Record<string, unknown> }]) => 'lastActivityAt' in args.updates
    )

  it('a terminal start or exit writes no stamp', () => {
    const store = storeWith()
    store.getState().bumpWorktreeActivity(wt.id)
    expect(lastActivityAt(store)).toBe(5)
    expect(persistedStamp()).toBe(false)
  })

  it('a bell or finish raises the unread flag but writes no stamp', () => {
    const store = storeWith()
    store.getState().markAgentAttentionUnread({
      workspaceId: wt.id,
      subjectKey: null,
      groupId: null,
      reason: 'agent-completion'
    })
    expect(store.getState().worktreesByRepo.repo1[0].isUnread).toBe(true)
    expect(lastActivityAt(store)).toBe(5)
    expect(persistedStamp()).toBe(false)
  })

  it('a comment edit writes no stamp', async () => {
    const store = storeWith()
    await store.getState().updateWorktreeMeta(wt.id, { comment: 'note' })
    expect(store.getState().worktreesByRepo.repo1[0].comment).toBe('note')
    expect(lastActivityAt(store)).toBe(5)
    expect(persistedStamp()).toBe(false)
  })

  it('a folder workspace’s terminal activity and unread mark write no stamp', async () => {
    const store = createTestStore()
    const folder = makeFolderWorkspace({ id: 'folder-1', lastActivityAt: 5 })
    store.setState({ folderWorkspaces: [folder], projectGroups: [] })
    store.getState().bumpWorktreeActivity(folderWorkspaceKey(folder.id))
    store.getState().markAgentAttentionUnread({
      workspaceId: folderWorkspaceKey(folder.id),
      subjectKey: null,
      groupId: null,
      reason: 'agent-completion'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().folderWorkspaces[0]).toMatchObject({
      isUnread: true,
      lastActivityAt: 5
    })
    const folderWrites = vi.mocked(store.getState().updateFolderWorkspace).mock.calls
    expect(folderWrites.some(([, updates]) => 'lastActivityAt' in updates)).toBe(false)
  })
})
