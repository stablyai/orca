import { describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, TEST_REPO } from '../store/slices/store-test-helpers'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from './editor-file-operation-owner'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'

const worktreeId = 'repo1::/workspace/repo'

function focusedStore() {
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, path: '/workspace/repo' }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/workspace/repo' })]
    },
    settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: null }),
    activeWorktreeId: worktreeId,
    activeWorkspaceExecutionHostId: 'runtime:other-host',
    recordFeatureInteraction: vi.fn()
  })
  return store
}

describe('editor file ownership across host focus', () => {
  it('opens an unstamped local file with local operation and tab ownership', () => {
    const store = focusedStore()
    const fileId = store.getState().openFile({
      filePath: '/workspace/repo/local.ts',
      relativePath: 'local.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
    const file = store.getState().openFiles.find((candidate) => candidate.id === fileId)
    if (!file) {
      throw new Error('Expected the opened file')
    }

    expect(getEditorFileOperationContext(store.getState(), file, '/workspace/repo')).toMatchObject({
      expectedExecutionHostId: 'local',
      settings: { activeRuntimeEnvironmentId: null }
    })
    expect(
      store.getState().unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === fileId)
        ?.executionHostId
    ).toBe('local')
  })

  it('keeps an explicit remote file and its editable tab on the captured host', () => {
    const store = focusedStore()
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/workspace/repo',
            hostId: 'runtime:file-host',
            runtimeOwnerEnvironmentId: 'file-host'
          })
        ]
      }
    })
    const fileId = store.getState().openFile({
      filePath: '/workspace/repo/remote.ts',
      relativePath: 'remote.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
    expect(
      store.getState().unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === fileId)
        ?.executionHostId
    ).toBe('runtime:file-host')
  })

  it('preserves the legacy global runtime fallback independently of workspace focus', () => {
    const store = focusedStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'legacy-host' }),
      runtimeEnvironments: [
        {
          id: 'legacy-host',
          name: 'Legacy host',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          preferredEndpointId: 'ws',
          endpoints: [{ id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://host' }]
        }
      ]
    })
    expect(
      captureEditorFileOperationProvenance(store.getState(), worktreeId, undefined, false)
        .generation.route
    ).toEqual({ executionHostId: 'runtime:legacy-host', runtimeEnvironmentId: 'legacy-host' })
  })

  it('keeps a direct SSH file on its target instead of the focused runtime', () => {
    const store = focusedStore()
    store.setState({
      repos: [{ ...TEST_REPO, connectionId: 'file-target' }],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', hostId: 'ssh:file-target' })]
      },
      sshConnectionStates: new Map([
        [
          'file-target',
          {
            targetId: 'file-target',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 7
          }
        ]
      ])
    })
    const fileId = store.getState().openFile({
      filePath: '/workspace/repo/ssh.ts',
      relativePath: 'ssh.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
    const file = store.getState().openFiles.find((candidate) => candidate.id === fileId)
    if (!file) {
      throw new Error('Expected the opened file')
    }
    expect(getEditorFileOperationContext(store.getState(), file, '/workspace/repo')).toMatchObject({
      connectionId: 'file-target',
      expectedExecutionHostId: 'ssh:file-target',
      expectedSshConnectionGeneration: 7,
      settings: { activeRuntimeEnvironmentId: null }
    })
    expect(
      store.getState().unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === fileId)
        ?.executionHostId
    ).toBe('ssh:file-target')
  })

  it('keeps generic workspace routing on the selected host', () => {
    const store = focusedStore()
    expect(resolveWorktreeOperationRoute(store.getState(), worktreeId)).toEqual({
      executionHostId: 'runtime:other-host',
      runtimeEnvironmentId: 'other-host'
    })
  })

  it('keeps a local folder file local through capture and revalidation after focus changes', () => {
    const store = focusedStore()
    const folderId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const folderKey = `folder:${folderId}`
    store.setState({
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      folderWorkspaces: [
        {
          id: folderId,
          projectGroupId: 'group',
          name: 'Folder',
          folderPath: '/workspace/folder',
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
    })
    const provenance = captureEditorFileOperationProvenance(
      store.getState(),
      folderKey,
      undefined,
      false
    )
    store.setState({
      activeWorktreeId: folderKey,
      activeWorkspaceExecutionHostId: 'runtime:other-host'
    })

    expect(assertEditorFileOperationCurrent(store.getState(), folderKey, provenance)).toEqual({
      executionHostId: 'local',
      runtimeEnvironmentId: null
    })
  })
})
