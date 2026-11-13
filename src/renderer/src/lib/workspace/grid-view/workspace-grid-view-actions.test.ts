import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { removeWorkspaceFromGridViewKeepingFocus } from './workspace-grid-view-actions'

type MockGridViewState = {
  activeWorktreeId: string | null
  workspaceGridViewMemberIds: readonly string[]
  folderWorkspaces: readonly { id: string }[]
  getKnownWorktreeById: (id: string) => { id: string } | undefined
  removeWorkspaceFromGridView: (id: string) => void
}

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  knownWorktreeIds: new Set<string>()
}))

vi.mock('../activation/worktree-activation', () => ({ activateAndRevealWorkspace: mocks.activate }))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const { removeWorkspaceGridViewMember } = await import('./workspace-grid-view-membership')
  return {
    useAppStore: create<MockGridViewState>((set, get) => ({
      activeWorktreeId: null,
      workspaceGridViewMemberIds: [],
      folderWorkspaces: [],
      getKnownWorktreeById: (id) => (mocks.knownWorktreeIds.has(id) ? { id } : undefined),
      removeWorkspaceFromGridView: (id) =>
        set({
          workspaceGridViewMemberIds: removeWorkspaceGridViewMember(
            get().workspaceGridViewMemberIds,
            id
          )
        })
    }))
  }
})

describe('removeWorkspaceFromGridViewKeepingFocus', () => {
  beforeEach(() => {
    mocks.activate.mockReset()
    mocks.knownWorktreeIds.clear()
  })

  it('moves focus past a member that no longer resolves', () => {
    for (const id of ['a', 'c', 'd']) {
      mocks.knownWorktreeIds.add(id)
    }
    useAppStore.setState({
      activeWorktreeId: 'a',
      workspaceGridViewMemberIds: ['a', 'gone', 'c', 'd']
    })

    removeWorkspaceFromGridViewKeepingFocus('a')

    expect(mocks.activate).toHaveBeenCalledWith('c')
    expect(useAppStore.getState().workspaceGridViewMemberIds).toEqual(['gone', 'c', 'd'])
  })

  it('leaves focus where it is when no other member resolves', () => {
    mocks.knownWorktreeIds.add('a')
    useAppStore.setState({ activeWorktreeId: 'a', workspaceGridViewMemberIds: ['a', 'gone'] })

    removeWorkspaceFromGridViewKeepingFocus('a')

    expect(mocks.activate).not.toHaveBeenCalled()
    expect(useAppStore.getState().workspaceGridViewMemberIds).toEqual([])
  })
})
