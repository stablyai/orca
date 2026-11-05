import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from './worktree-activation'
import './workspace-switch-user-act'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('activateAndRevealWorktree automation filters', () => {
  it('stays in the activity view when a blocked folder activation fails', () => {
    const getFreshFolderWorkspacePathStatus = vi.fn(() => ({
      path: '/gone',
      exists: false,
      reason: 'missing' as const
    }))
    useAppStore.setState({
      sidebarBody: 'agents',
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          name: 'gone',
          folderPath: '/gone',
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
      getFreshFolderWorkspacePathStatus
    })

    expect(activateAndRevealWorkspace('folder:folder-1', { showWorkspaceList: true })).toBe(false)
    expect(getFreshFolderWorkspacePathStatus).toHaveBeenCalled()
    expect(useAppStore.getState().sidebarBody).toBe('agents')
  })
})
