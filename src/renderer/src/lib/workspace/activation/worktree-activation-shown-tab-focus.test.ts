import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { activateAndRevealFolderWorkspace, activateAndRevealWorktree } from './worktree-activation'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'

const initialAppStoreState = useAppStore.getState()
const RUN_TAB_ID = '11111111-2222-4333-8444-555555555555'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  vi.useRealTimers()
})

/** A tab main created for a run in a background workspace, as the window adopts it. */
function adoptRunTab(workspaceKey: string): void {
  useAppStore.getState().createTab(workspaceKey, undefined, undefined, {
    id: RUN_TAB_ID,
    initialPtyId: 'pty-run'
  })
  expect(useAppStore.getState().getTab(RUN_TAB_ID)?.lastFocusedAt).toBeUndefined()
}

describe('opening a workspace focuses the tab it shows', () => {
  it('stamps the run tab a worktree visit shows without a tab click', () => {
    vi.useFakeTimers({ now: 50_000, toFake: ['Date'] })
    const worktree = makeCreatedAgentWorktree()
    seedEmptyActivatableWorktree(worktree)
    adoptRunTab(worktree.id)

    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    expect(useAppStore.getState().getTab(RUN_TAB_ID)?.lastFocusedAt).toBe(50_000)
  })

  it('stamps the run tab a folder visit shows without a tab click', () => {
    vi.useFakeTimers({ now: 60_000, toFake: ['Date'] })
    const folderKey = folderWorkspaceKey('folder-1')
    useAppStore.setState({
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          name: 'notes',
          folderPath: '/local/notes',
          executionHostId: 'local',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      ],
      activeView: 'terminal',
      getFreshFolderWorkspacePathStatus: () => ({ path: '/local/notes', exists: true }),
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      revealWorktreeInSidebar: vi.fn()
    })
    adoptRunTab(folderKey)

    activateAndRevealFolderWorkspace('folder-1')

    expect(useAppStore.getState().getTab(RUN_TAB_ID)?.lastFocusedAt).toBe(60_000)
  })
})
