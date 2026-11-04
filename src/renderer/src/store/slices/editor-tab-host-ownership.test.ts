import { describe, expect, it } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import './worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'

describe('editor owners ignore unrelated workspace focus', () => {
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
