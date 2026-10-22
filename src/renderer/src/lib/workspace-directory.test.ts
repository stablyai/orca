import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  detectedListingFixture,
  worktreeFixture
} from '../components/native-chat/native-chat-workspace-test-fixtures'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { resolveWorkspaceDirectory, type WorkspaceDirectoryState } from './workspace-directory'

function catalog(overrides: Partial<WorkspaceDirectoryState> = {}): WorkspaceDirectoryState {
  return {
    detectedWorktreesByRepo: {},
    floatingWorkspacePath: null,
    folderWorkspaces: [],
    worktreesByRepo: { repo: [worktreeFixture('wt-1', '/visible', { hostId: 'local' })] },
    ...overrides
  }
}

describe('resolveWorkspaceDirectory', () => {
  it('prefers a visible catalog row and resolves a detected-only row from the same snapshot', () => {
    const state = catalog({
      detectedWorktreesByRepo: {
        repo: detectedListingFixture([
          worktreeFixture('wt-1', '/detected-shadow', { hostId: 'local' }),
          worktreeFixture('wt-detected', '/detected', { hostId: 'ssh:box-1' })
        ])
      }
    })

    expect(resolveWorkspaceDirectory(state, 'wt-1')).toBe('/visible')
    expect(resolveWorkspaceDirectory(state, 'wt-detected', 'ssh:box-1')).toBe('/detected')
    expect(resolveWorkspaceDirectory(state, 'wt-detected', 'local')).toBeNull()
  })

  it('resolves folder workspaces without a projected worktree row', () => {
    const folderId = 'folder-1'
    expect(
      resolveWorkspaceDirectory(
        catalog({
          folderWorkspaces: [
            {
              id: folderId,
              projectGroupId: 'group-1',
              name: 'Platform',
              folderPath: '/workspace/platform',
              connectionId: null,
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
          ]
        }),
        folderWorkspaceKey(folderId)
      )
    ).toBe('/workspace/platform')
  })

  it('does not resolve a folder workspace on a different host', () => {
    const folderId = 'folder-1'
    expect(
      resolveWorkspaceDirectory(
        catalog({
          folderWorkspaces: [
            {
              id: folderId,
              projectGroupId: 'group-1',
              name: 'Remote Platform',
              folderPath: '/workspace/remote-platform',
              connectionId: 'box-1',
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
          ]
        }),
        folderWorkspaceKey(folderId),
        'local'
      )
    ).toBeNull()
  })

  it('applies the same host rules when the caller passes no detected rows', () => {
    const folderKey = folderWorkspaceKey('folder-1')
    const state: WorkspaceDirectoryState = {
      floatingWorkspacePath: null,
      folderWorkspaces: [
        makeFolderWorkspace({ folderPath: '/workspace/remote', connectionId: 'box-1' })
      ],
      worktreesByRepo: { repo: [worktreeFixture('wt-1', '/visible')] }
    }

    // Why: an unhosted row is a local row, and a folder on another host is not this one.
    expect(resolveWorkspaceDirectory(state, 'wt-1', 'local')).toBe('/visible')
    expect(resolveWorkspaceDirectory(state, folderKey, 'local')).toBeNull()
    expect(resolveWorkspaceDirectory(state, folderKey, 'ssh:box-1')).toBe('/workspace/remote')
  })
})
