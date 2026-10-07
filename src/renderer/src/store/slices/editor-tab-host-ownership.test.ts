import { describe, expect, it } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { makeWorktree, TEST_REPO } from './store-test-helpers'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'

describe('editor tabs retain their captured file owner', () => {
  it.each([
    { hostId: 'local', runtimeEnvironmentId: null },
    { hostId: 'runtime:wsl', runtimeEnvironmentId: 'wsl' },
    { hostId: 'ssh:linux', runtimeEnvironmentId: null },
    { hostId: 'ssh:linux', runtimeEnvironmentId: 'wsl' }
  ] as const)('keeps $hostId via $runtimeEnvironmentId while another host is focused', (owner) => {
    const store = createEditorTabsStore()
    store.setState({
      repos: [{ ...TEST_REPO, id: 'repo-1', path: '/repo', executionHostId: owner.hostId }],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo',
            hostId: owner.hostId,
            ...(owner.runtimeEnvironmentId
              ? { runtimeOwnerEnvironmentId: owner.runtimeEnvironmentId }
              : {})
          })
        ]
      },
      activeWorktreeId: 'wt-1',
      activeWorkspaceExecutionHostId: 'runtime:mac',
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map()
    })

    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    const file = store.getState().openFiles[0]
    expect(file?.operationProvenance?.generation.route).toEqual({
      executionHostId: owner.hostId,
      runtimeEnvironmentId: owner.runtimeEnvironmentId
    })
    expect(
      store.getState().unifiedTabsByWorktree['wt-1']?.find((tab) => tab.entityId === file?.id)
        ?.executionHostId
    ).toBe(owner.hostId)
  })
})

describe('editor owners ignore unrelated workspace focus', () => {
  it('captures an unstamped local worktree independently of the focused host', () => {
    const store = createEditorTabsStore()
    store.setState({
      repos: [{ ...TEST_REPO, id: 'repo-1', path: '/repo' }],
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo' })]
      },
      activeWorkspaceExecutionHostId: 'runtime:mac',
      settings: { ...getDefaultSettings('/tmp/orca-test'), activeRuntimeEnvironmentId: null }
    })

    expect(
      captureEditorFileOperationProvenance(store.getState(), 'wt-1', undefined, false).generation
        .route
    ).toEqual({
      executionHostId: 'local',
      runtimeEnvironmentId: null
    })
  })

  function folderStore() {
    const store = createEditorTabsStore()
    store.setState({
      activeWorktreeId: 'folder:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      settings: { ...getDefaultSettings('/tmp/orca-test'), activeRuntimeEnvironmentId: null },
      folderWorkspaces: [
        {
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          projectGroupId: 'group',
          name: 'Folder',
          folderPath: '/folder',
          connectionId: null,
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
      projectGroups: [
        {
          id: 'group',
          name: 'Group',
          parentPath: null,
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          executionHostId: 'local',
          createdAt: 0,
          updatedAt: 0
        }
      ]
    })
    return store
  }

  it('captures a folder owner while another host is focused', () => {
    const store = folderStore()
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:mac' })
    const route = captureEditorFileOperationProvenance(
      store.getState(),
      'folder:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      undefined,
      false
    ).generation.route
    expect(route).toEqual({ executionHostId: 'local', runtimeEnvironmentId: null })
  })

  it('disambiguates same-id folders from catalog evidence and retains the captured owner', () => {
    const store = folderStore()
    const folderKey = 'folder:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const localFolder = store.getState().folderWorkspaces[0]
    if (!localFolder) {
      throw new Error('Missing folder fixture')
    }
    store.setState({
      folderWorkspaces: [localFolder, { ...localFolder, executionHostId: 'runtime:wsl' }],
      activeWorkspaceExecutionHostId: 'local'
    })
    const provenance = captureEditorFileOperationProvenance(
      store.getState(),
      folderKey,
      undefined,
      false
    )
    expect(provenance.generation.route).toEqual({
      executionHostId: 'local',
      runtimeEnvironmentId: null
    })
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:wsl' })
    expect(assertEditorFileOperationCurrent(store.getState(), folderKey, provenance)).toEqual(
      provenance.generation.route
    )
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:absent' })
    expect(() =>
      captureEditorFileOperationProvenance(store.getState(), folderKey, undefined, false)
    ).toThrow('Reopen the file')
  })

  it('keeps a captured folder readable after focus changes but rejects an owner change', () => {
    const store = folderStore()
    const folderKey = 'folder:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const provenance = captureEditorFileOperationProvenance(
      store.getState(),
      folderKey,
      undefined,
      false
    )
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:mac' })
    expect(assertEditorFileOperationCurrent(store.getState(), folderKey, provenance)).toEqual(
      provenance.generation.route
    )

    store.setState({
      folderWorkspaces: store.getState().folderWorkspaces.map((folder) => ({
        ...folder,
        executionHostId: 'runtime:wsl'
      }))
    })
    expect(() => assertEditorFileOperationCurrent(store.getState(), folderKey, provenance)).toThrow(
      'Reopen the file'
    )
  })
})
