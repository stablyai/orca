import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  folderWorkspaceBrowserContentBelongsToRemovedOwner,
  folderWorkspaceEditorFileBelongsToRemovedOwner
} from './folder-workspace-content-removal-snapshot'
import { pruneFolderWorkspaceContentState } from './folder-workspace-content-state-pruning'
import { createTestStore } from './store-test-helpers'

describe('folder workspace recently closed content pruning', () => {
  it('preserves editor content with contradictory host evidence', () => {
    const ownerATargetId = 'ssh-a'
    const ownerBTargetId = 'ssh-b'
    const file = {
      externalSshTargetId: ownerBTargetId,
      operationProvenance: {
        generation: {
          route: {
            executionHostId: toSshExecutionHostId(ownerATargetId),
            runtimeEnvironmentId: null
          }
        }
      }
    } as never

    expect(
      folderWorkspaceEditorFileBelongsToRemovedOwner(file, {
        kind: 'ssh',
        hostId: toSshExecutionHostId(ownerATargetId),
        targetId: ownerATargetId,
        workspaceKeys: ['folder:shared']
      })
    ).toBe(false)
    expect(
      folderWorkspaceEditorFileBelongsToRemovedOwner(file, {
        kind: 'ssh',
        hostId: toSshExecutionHostId(ownerBTargetId),
        targetId: ownerBTargetId,
        workspaceKeys: ['folder:shared']
      })
    ).toBe(false)
  })

  it('preserves legacy browser content with conflicting host evidence', () => {
    const ownerHostId = toSshExecutionHostId('ssh-owner')
    const siblingHostId = toSshExecutionHostId('ssh-sibling')
    const pages = [
      { workspaceExecutionHostId: ownerHostId },
      { workspaceExecutionHostId: siblingHostId }
    ] as never
    const ownerRemoval = {
      kind: 'ssh' as const,
      hostId: ownerHostId,
      targetId: 'ssh-owner',
      workspaceKeys: ['folder:shared']
    }

    expect(
      folderWorkspaceBrowserContentBelongsToRemovedOwner(undefined, pages, [], ownerRemoval)
    ).toBe(false)
  })

  it('preserves legacy browser content with conflicting runtime evidence', () => {
    const environmentId = 'runtime-owner'
    const ownerRemoval = {
      kind: 'runtime' as const,
      environmentId,
      hostId: toRuntimeExecutionHostId(environmentId),
      workspaceKeys: ['folder:shared']
    }
    const pages = [
      { browserRuntimeEnvironmentId: environmentId },
      { browserRuntimeEnvironmentId: 'runtime-sibling' }
    ] as never

    expect(
      folderWorkspaceBrowserContentBelongsToRemovedOwner(undefined, pages, [], ownerRemoval)
    ).toBe(false)
  })

  it('removes only the deleted owner while preserving interleaved reopen order', () => {
    const workspaceKey = folderWorkspaceKey('shared')
    const otherWorkspaceKey = folderWorkspaceKey('other')
    const ownerTargetId = 'ssh-owner'
    const siblingTargetId = 'ssh-sibling'
    const ownerHostId = toSshExecutionHostId(ownerTargetId)
    const siblingHostId = toSshExecutionHostId(siblingTargetId)
    const ownerBrowser = {
      workspace: {
        id: 'closed-browser-owner',
        worktreeId: workspaceKey,
        workspaceExecutionHostId: ownerHostId
      },
      pages: []
    }
    const siblingBrowser = {
      workspace: {
        id: 'closed-browser-sibling',
        worktreeId: workspaceKey,
        workspaceExecutionHostId: siblingHostId
      },
      pages: []
    }
    const siblingFile = {
      filePath: '/sibling/closed.ts',
      relativePath: 'closed.ts',
      worktreeId: workspaceKey,
      language: 'typescript',
      mode: 'edit',
      externalSshTargetId: siblingTargetId
    }
    const ownerFile = {
      ...siblingFile,
      filePath: '/owner/closed.ts',
      externalSshTargetId: ownerTargetId
    }
    const otherBrowser = {
      workspace: {
        id: 'closed-browser-other-workspace',
        worktreeId: otherWorkspaceKey,
        workspaceExecutionHostId: ownerHostId
      },
      pages: []
    }
    const store = createTestStore()
    store.setState({
      recentlyClosedBrowserTabsByWorktree: {
        [workspaceKey]: [ownerBrowser, siblingBrowser],
        [otherWorkspaceKey]: [otherBrowser]
      } as never,
      recentlyClosedEditorTabsByWorktree: {
        [workspaceKey]: [siblingFile, ownerFile]
      } as never,
      recentlyClosedTerminalTabsByWorktree: {
        [workspaceKey]: [{ startupCwd: '/owner' }, { startupCwd: '/sibling' }]
      },
      recentlyClosedTabKindsByWorktree: {
        [workspaceKey]: ['browser', 'terminal', 'editor', 'browser', 'editor'],
        [otherWorkspaceKey]: ['browser']
      }
    })

    store.setState(
      pruneFolderWorkspaceContentState(store.getState(), {
        browserWorkspaceIds: [],
        editorFileIds: [],
        ownerRemoval: {
          kind: 'ssh',
          hostId: ownerHostId,
          targetId: ownerTargetId,
          workspaceKeys: [workspaceKey]
        },
        unifiedTabIds: [],
        workspaceKey
      })
    )

    const state = store.getState()
    expect(state.recentlyClosedBrowserTabsByWorktree[workspaceKey]).toEqual([siblingBrowser])
    expect(state.recentlyClosedEditorTabsByWorktree[workspaceKey]).toEqual([siblingFile])
    expect(state.recentlyClosedTerminalTabsByWorktree[workspaceKey]).toEqual([])
    expect(state.recentlyClosedTabKindsByWorktree[workspaceKey]).toEqual(['editor', 'browser'])
    expect(state.recentlyClosedBrowserTabsByWorktree[otherWorkspaceKey]).toEqual([otherBrowser])
    expect(state.recentlyClosedTabKindsByWorktree[otherWorkspaceKey]).toEqual(['browser'])
  })
})
