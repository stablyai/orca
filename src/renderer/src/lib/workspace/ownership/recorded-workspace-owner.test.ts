import { describe, expect, it, vi } from 'vitest'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { hostlessChatsAreLocal, recordedWorkspaceOwner } from './recorded-workspace-owner'

const HOME = 'folder:home'

describe('recorded workspace owner', () => {
  it('names this app for its own folder and nobody for one it has no record of', () => {
    const own = { folderWorkspaces: [makeFolderWorkspace({ id: 'home' })] }
    expect(recordedWorkspaceOwner(own, HOME)).toBe('local')
    expect(recordedWorkspaceOwner({ folderWorkspaces: [] }, HOME)).toBeNull()
  })

  it('names nobody for a folder two hosts publish, even while one is selected', () => {
    const state = {
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'home', executionHostId: 'local' }),
        makeFolderWorkspace({ id: 'home', executionHostId: 'runtime:env-1' })
      ],
      activeWorktreeId: HOME,
      activeWorkspaceExecutionHostId: 'local' as const
    }
    expect(recordedWorkspaceOwner(state, HOME)).toBeNull()
    expect(hostlessChatsAreLocal(state, HOME)()).toBe(false)
  })

  it('reads the records only when asked, and once however often', () => {
    const read = vi.fn(() => [makeFolderWorkspace({ id: 'home' })])
    const local = hostlessChatsAreLocal(
      {
        get folderWorkspaces() {
          return read()
        }
      },
      HOME
    )
    expect(read).not.toHaveBeenCalled()
    expect([local(), local()]).toEqual([true, true])
    expect(read).toHaveBeenCalledTimes(1)
  })
})
