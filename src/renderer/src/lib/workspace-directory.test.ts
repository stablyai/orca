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
