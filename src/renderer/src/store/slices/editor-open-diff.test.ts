import { describe, expect, it, vi } from 'vitest'
import { createEditorStore, createEditorTabsStore } from './editor-slice-test-harness'
import type { AppState } from '../types'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

describe('createEditorSlice openDiff', () => {
  it('keeps staged and unstaged diffs in separate tabs', () => {
    const store = createEditorStore()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', true)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([
      'wt-1::diff::unstaged::file.ts',
      'wt-1::diff::staged::file.ts'
    ])
  })

  it('keeps local and runtime-owned diffs in separate tabs for the same path', () => {
    const store = createEditorStore()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false, {
      runtimeEnvironmentId: 'env-1'
    })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::file.ts',
        runtimeEnvironmentId: null
      }),
      expect.objectContaining({
        id: 'editor-diff:wt-1:env-1:unstaged:file.ts',
        runtimeEnvironmentId: 'env-1'
      })
    ])
  })

  it('derives a runtime owner for source-control diffs from the worktree host', () => {
    const store = createEditorStore()
    store.setState({
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-1' }] as unknown as AppState['repos'],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'repo-1::/srv/repo/worktree',
            repoId: 'repo-1',
            hostId: 'runtime:env-1'
          }
        ]
      } as unknown as AppState['worktreesByRepo']
    })

    store
      .getState()
      .openDiff(
        'repo-1::/srv/repo/worktree',
        '/srv/repo/worktree/src/file.ts',
        'src/file.ts',
        'typescript',
        false
      )

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'editor-diff:repo-1%3A%3A%2Fsrv%2Frepo%2Fworktree:env-1:unstaged:src%2Ffile.ts',
        runtimeEnvironmentId: 'env-1'
      })
    )
  })

  it('keeps a diff for an owner-less worktree off the focused global runtime', () => {
    const store = createEditorStore()
    // A remote runtime is globally focused, but wt-1's repo names no explicit
    // owner. The diff must stamp null (not undefined): null forces a LOCAL read
    // in settingsForRuntimeOwner, while undefined would inherit 'focused-env'.
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as AppState['settings']
    })

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::file.ts',
        runtimeEnvironmentId: null
      })
    )
  })

  it('routes an explicitly runtime-owned worktree diff to its owner over the focused runtime', () => {
    const store = createEditorStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as AppState['settings'],
      repos: [
        { id: 'repo-1', executionHostId: 'runtime:owner-env' }
      ] as unknown as AppState['repos'],
      worktreesByRepo: {
        'repo-1': [{ id: 'repo-1::/srv/wt', repoId: 'repo-1', hostId: 'runtime:owner-env' }]
      } as unknown as AppState['worktreesByRepo']
    })

    store.getState().openDiff('repo-1::/srv/wt', '/srv/wt/file.ts', 'file.ts', 'typescript', false)

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({ runtimeEnvironmentId: 'owner-env' })
    )
  })

  it('keeps an SSH-owned worktree diff off the focused runtime so it routes via its connection', () => {
    const store = createEditorStore()
    // An SSH worktree is owned by its connection, not the focused runtime. Its
    // diff stamps null (not the focused env), so the read targets local IPC and
    // flows over connectionId rather than the focused runtime's RPC.
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as AppState['settings'],
      repos: [{ id: 'repo-ssh', connectionId: 'conn-1' }] as unknown as AppState['repos'],
      worktreesByRepo: {
        'repo-ssh': [{ id: 'repo-ssh::/srv/wt', repoId: 'repo-ssh', hostId: 'ssh:conn-1' }]
      } as unknown as AppState['worktreesByRepo']
    })

    store
      .getState()
      .openDiff('repo-ssh::/srv/wt', '/srv/wt/file.ts', 'file.ts', 'typescript', false)

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({ runtimeEnvironmentId: null })
    )
  })

  it('repairs an existing diff tab entry to the correct mode and staged state', () => {
    const store = createEditorStore()

    store.setState({
      openFiles: [
        {
          id: 'wt-1::diff::staged::file.ts',
          filePath: '/repo/file.ts',
          relativePath: 'file.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ],
      activeFileId: null,
      activeFileIdByWorktree: {},
      activeTabTypeByWorktree: {},
      activeTabType: 'terminal'
    })

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', true)

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::staged::file.ts',
        mode: 'diff',
        diffSource: 'staged'
      })
    ])
    expect(store.getState().activeFileId).toBe('wt-1::diff::staged::file.ts')
  })

  it('bumps diffContentReloadNonce when re-opening an existing diff tab', () => {
    const store = createEditorStore()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    expect(store.getState().openFiles[0]?.diffContentReloadNonce).toBeUndefined()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    expect(store.getState().openFiles[0]?.diffContentReloadNonce).toBe(1)

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    expect(store.getState().openFiles[0]?.diffContentReloadNonce).toBe(2)
  })

  it('bumps fileContentReloadNonce when re-opening an existing clean file with reload requested', () => {
    const store = createEditorStore()

    const openFileWithReloadRequest = (): void => {
      store.getState().openFile(
        {
          filePath: '/repo/file.ts',
          relativePath: 'file.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit'
        },
        { forceContentReload: true }
      )
    }

    openFileWithReloadRequest()
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBeUndefined()

    openFileWithReloadRequest()
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBe(1)

    openFileWithReloadRequest()
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBe(2)
  })

  it('reuses a restored local WSL alias without folding the Linux path tail', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    const store = createEditorStore()
    const restoredPath = '//wsl.localhost/Ubuntu/home/Alice/repo/file.ts'
    store.setState({
      openFiles: [
        {
          id: restoredPath,
          filePath: restoredPath,
          relativePath: 'file.ts',
          worktreeId: 'wt-1',
          runtimeEnvironmentId: null,
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    })

    expect(
      store.getState().openFile(
        {
          filePath: '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\file.ts',
          relativePath: 'file.ts',
          worktreeId: 'wt-1',
          runtimeEnvironmentId: null,
          language: 'typescript',
          mode: 'edit'
        },
        { suppressActiveRuntimeFallback: true }
      )
    ).toBe(restoredPath)
    expect(store.getState().openFiles).toHaveLength(1)

    store.getState().openFile(
      {
        filePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\file.ts',
        relativePath: 'file.ts',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'typescript',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    expect(store.getState().openFiles).toHaveLength(2)
    vi.unstubAllGlobals()
  })

  it('keeps local WSL-looking aliases distinct on POSIX clients', () => {
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    const store = createEditorStore()
    store.setState({
      openFiles: [
        {
          id: 'forward',
          filePath: '//wsl.localhost/Ubuntu/repo/file.ts',
          relativePath: 'file.ts',
          worktreeId: 'wt-1',
          runtimeEnvironmentId: null,
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    })

    store.getState().openFile(
      {
        filePath: '\\\\wsl.localhost\\Ubuntu\\repo\\file.ts',
        relativePath: 'file.ts',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'typescript',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    expect(store.getState().openFiles).toHaveLength(2)
    vi.unstubAllGlobals()
  })

  it('does not reuse WSL aliases for SSH-owned tabs', () => {
    const store = createEditorStore()
    store.setState({
      repos: [{ id: 'repo-1', path: '/repo', connectionId: 'ssh-1' }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'ssh:ssh-1' }]
      },
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 1
          }
        ]
      ]),
      openFiles: [
        {
          id: 'ssh-forward',
          filePath: '//wsl.localhost/Ubuntu/repo/file.ts',
          relativePath: 'file.ts',
          worktreeId: 'wt-1',
          runtimeEnvironmentId: null,
          externalSshTargetId: 'ssh-1',
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    } as never)

    store.getState().openFile({
      filePath: '\\\\wsl.localhost\\Ubuntu\\repo\\file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      externalSshTargetId: 'ssh-1',
      language: 'typescript',
      mode: 'edit'
    })

    expect(store.getState().openFiles).toHaveLength(2)
  })

  it('rebinds an existing external tab when it is reopened from a new SSH host', () => {
    const store = createEditorStore()
    const file = {
      filePath: '/tmp/ssh-preview.png',
      relativePath: '/tmp/ssh-preview.png',
      worktreeId: 'wt-1',
      language: 'png',
      mode: 'edit' as const
    }

    store.setState({
      repos: [{ id: 'repo-1', path: '/repo', connectionId: 'ssh-1' }],
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 1
          }
        ]
      ])
    } as never)
    store.getState().openFile({ ...file, externalSshTargetId: 'ssh-1' })

    store.setState({
      repos: [{ id: 'repo-1', path: '/repo', connectionId: 'ssh-2' }],
      sshConnectionStates: new Map([
        [
          'ssh-2',
          {
            targetId: 'ssh-2',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 2
          }
        ]
      ])
    } as never)
    store.getState().openFile({ ...file, externalSshTargetId: 'ssh-2' })

    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.externalSshTargetId).toBe('ssh-2')
    expect(store.getState().openFiles[0]?.operationProvenance).toEqual(
      expect.objectContaining({
        generation: expect.objectContaining({
          route: { executionHostId: 'ssh:ssh-2', runtimeEnvironmentId: null }
        }),
        expectedSshConnectionGeneration: 2
      })
    )
  })

  it('does not bump fileContentReloadNonce when a dirty file is re-opened', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().markFileDirty('/repo/file.ts', true)

    store.getState().openFile(
      {
        filePath: '/repo/file.ts',
        relativePath: 'file.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { forceContentReload: true }
    )

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        isDirty: true,
        fileContentReloadNonce: undefined
      })
    )
  })

  it('opens the visible diff tab in the requested split group', () => {
    const store = createEditorTabsStore()
    const sourceTab = store.getState().createUnifiedTab('wt-1', 'terminal', { id: 'terminal-1' })
    const targetGroupId = store.getState().createEmptySplitGroup('wt-1', sourceTab.groupId, 'right')
    if (!targetGroupId) {
      throw new Error('expected split group')
    }

    store
      .getState()
      .openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false, { targetGroupId })

    const diffTab = store
      .getState()
      .unifiedTabsByWorktree['wt-1']?.find((tab) => tab.contentType === 'diff')

    expect(diffTab?.groupId).toBe(targetGroupId)
    expect(diffTab?.entityId).toBe('wt-1::diff::unstaged::file.ts')
    expect(store.getState().activeGroupIdByWorktree['wt-1']).toBe(targetGroupId)
  })

  it('keeps a diff tab selectable after opening its target file tab', () => {
    const store = createEditorTabsStore()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    const diffFileId = 'wt-1::diff::unstaged::file.ts'
    const diffTab = store
      .getState()
      .unifiedTabsByWorktree['wt-1']?.find((tab) => tab.contentType === 'diff')
    if (!diffTab) {
      throw new Error('expected diff tab')
    }

    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    const stateAfterOpen = store.getState()
    const editFile = stateAfterOpen.openFiles.find((file) => file.mode === 'edit')
    expect(stateAfterOpen.openFiles.find((file) => file.id === diffFileId)).toEqual(
      expect.objectContaining({ mode: 'diff' })
    )
    expect(editFile).toEqual(expect.objectContaining({ id: '/repo/file.ts', mode: 'edit' }))
    expect(
      stateAfterOpen.unifiedTabsByWorktree['wt-1']?.find((tab) => tab.contentType === 'editor')
        ?.entityId
    ).toBe('/repo/file.ts')

    store.getState().activateTab(diffTab.id)
    store.getState().setActiveFile(diffFileId)

    const stateAfterReselect = store.getState()
    expect(stateAfterReselect.groupsByWorktree['wt-1']?.[0]?.activeTabId).toBe(diffTab.id)
    expect(stateAfterReselect.activeFileId).toBe(diffFileId)
    expect(stateAfterReselect.openFiles.find((file) => file.id === diffFileId)?.mode).toBe('diff')
  })

  it('reuses a preview editor tab when opening a preview diff', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        filePath: '/repo/b.ts',
        isPreview: true,
        mode: 'diff'
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        contentType: 'diff',
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
  })

  it('keeps an existing preview replaceable when it is opened as preview again', () => {
    const store = createEditorTabsStore()

    const openPreviewFile = (): void => {
      store.getState().openFile(
        {
          filePath: '/repo/a.ts',
          relativePath: 'a.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit'
        },
        { preview: true }
      )
    }

    openPreviewFile()
    openPreviewFile()

    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: '/repo/a.ts',
        isPreview: true
      })
    ])

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
  })

  it('does not orphan another split group when replacing a shared preview diff', () => {
    const store = createEditorTabsStore()

    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, { preview: true })
    const firstGroupId = store.getState().groupsByWorktree['wt-1'][0].id
    const secondGroupId = store.getState().createEmptySplitGroup('wt-1', firstGroupId, 'right')

    expect(secondGroupId).toBeTruthy()

    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, {
      preview: true,
      targetGroupId: secondGroupId ?? undefined
    })
    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, {
      preview: true,
      targetGroupId: secondGroupId ?? undefined
    })

    const state = store.getState()
    expect(state.openFiles).toEqual([
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::a.ts',
        isPreview: true
      }),
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    expect(state.unifiedTabsByWorktree['wt-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: firstGroupId,
          entityId: 'wt-1::diff::unstaged::a.ts',
          isPreview: true
        }),
        expect.objectContaining({
          groupId: secondGroupId,
          entityId: 'wt-1::diff::unstaged::b.ts',
          isPreview: true
        })
      ])
    )
  })

  it('opens a new preview diff beside a pinned file tab', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().pinFile('/repo/a.ts')

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/a.ts',
        isPreview: undefined
      }),
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: '/repo/a.ts',
        isPinned: true,
        isPreview: false
      }),
      expect.objectContaining({
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
  })

  it('makes a preview file permanent without pinning the tab', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().makePreviewFilePermanent('/repo/a.ts')

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/a.ts',
        isPreview: undefined
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: '/repo/a.ts',
        isPinned: undefined,
        isPreview: false
      })
    ])
  })

  it('does not replace a dirty file that was opened as a preview', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().markFileDirty('/repo/a.ts', true)

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/a.ts',
        isDirty: true,
        isPreview: undefined
      }),
      expect.objectContaining({
        id: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: '/repo/a.ts',
        isPreview: false
      }),
      expect.objectContaining({
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
  })
})
