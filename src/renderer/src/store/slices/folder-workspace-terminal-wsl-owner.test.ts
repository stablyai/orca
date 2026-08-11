import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore } from './store-test-helpers'

const workspaceId = 'shared-folder'
const workspaceKey = folderWorkspaceKey(workspaceId)

function folder(
  executionHostId: FolderWorkspace['executionHostId'],
  folderPath: string
): FolderWorkspace {
  return {
    id: workspaceId,
    projectGroupId: 'group-1',
    name: folderPath,
    folderPath,
    executionHostId,
    connectionId: executionHostId === 'local' ? null : 'ssh-1',
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
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('folder workspace terminal WSL owner selection', () => {
  it.each([['local-first' as const], ['ssh-first' as const]])(
    'uses the active owner path with %s catalog order',
    (order) => {
      vi.stubGlobal('navigator', { userAgent: 'Windows' })
      const local = folder('local', '\\\\wsl.localhost\\Ubuntu\\home\\ada\\project')
      const ssh = folder('ssh:ssh-1', '/srv/project')
      const store = createTestStore()
      store.setState({
        settings: {
          ...store.getState().settings!,
          terminalWindowsShell: 'powershell.exe'
        },
        activeWorktreeId: workspaceKey,
        activeWorkspaceExecutionHostId: 'local',
        folderWorkspaces: order === 'local-first' ? [local, ssh] : [ssh, local]
      })

      expect(store.getState().createTab(workspaceKey).shellOverride).toBe('wsl.exe')
    }
  )
})
