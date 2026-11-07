import { describe, expect, it, vi } from 'vitest'
import { createEditorStore, createEditorTabsStore } from '../editor-slice-test-harness'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { makeLayout, makeTab } from '../../store-session-test-harness'
import { drawTabsFromMain } from '../../tabs-drawn-from-main.test-fixture'
import { withLayoutOwnerTabProps } from '@/components/tab-bar/tab-bar-layout-owner-props'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

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

  it('opens the visible diff tab in the requested split group', async () => {
    const store = createEditorTabsStore()
    // A terminal with its row, so main holds it and its group.
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'terminal-1', worktreeId: 'wt-1' })] },
      terminalLayoutsByTabId: { 'terminal-1': makeLayout() }
    })
    store.getState().createUnifiedTab('wt-1', 'terminal', { id: 'terminal-1' })
    const main = await drawTabsFromMain(store)
    const sourceTab = store.getState().unifiedTabsByWorktree['wt-1']![0]!
    const targetGroupId = store.getState().createEmptySplitGroup('wt-1', sourceTab.groupId, 'right')
    if (!targetGroupId) {
      throw new Error('expected split group')
    }

    store
      .getState()
      .openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false, { targetGroupId })
    await main.settle()

    const diffTab = store
      .getState()
      .unifiedTabsByWorktree['wt-1']?.find((tab) => tab.contentType === 'diff')

    expect(diffTab?.groupId).toBe(targetGroupId)
    expect(diffTab?.entityId).toBe('wt-1::diff::unstaged::file.ts')
    expect(store.getState().activeGroupIdByWorktree['wt-1']).toBe(targetGroupId)
  })

  it('keeps a diff tab selectable after opening its target file tab', async () => {
    const store = createEditorTabsStore()
    const main = await drawTabsFromMain(store)

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    await main.settle()
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
    await main.settle()

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
    await main.settle()
    store.getState().setActiveFile(diffFileId)

    const stateAfterReselect = store.getState()
    expect(stateAfterReselect.groupsByWorktree['wt-1']?.[0]?.activeTabId).toBe(diffTab.id)
    expect(stateAfterReselect.activeFileId).toBe(diffFileId)
    expect(stateAfterReselect.openFiles.find((file) => file.id === diffFileId)?.mode).toBe('diff')
  })

  it('keeps an existing preview replaceable when it is opened as preview again', async () => {
    const store = createEditorTabsStore()
    const main = await drawTabsFromMain(store)

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
    await main.settle()
    openPreviewFile()
    await main.settle()

    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({
        entityId: '/repo/a.ts',
        isPreview: true
      })
    ])

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })
    await main.settle()

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

  it('does not orphan another split group when replacing a shared preview diff', async () => {
    const store = createEditorTabsStore()
    const main = await drawTabsFromMain(store)

    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, { preview: true })
    await main.settle()
    const firstGroupId = store.getState().groupsByWorktree['wt-1'][0].id
    const secondGroupId = store.getState().createEmptySplitGroup('wt-1', firstGroupId, 'right')

    expect(secondGroupId).toBeTruthy()

    store.getState().openDiff('wt-1', '/repo/a.ts', 'a.ts', 'typescript', false, {
      preview: true,
      targetGroupId: secondGroupId ?? undefined
    })
    await main.settle()
    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, {
      preview: true,
      targetGroupId: secondGroupId ?? undefined
    })
    await main.settle()

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

  it('opens a new preview diff beside a pinned file tab', async () => {
    const store = createEditorTabsStore()
    const main = await drawTabsFromMain(store)

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
    await main.settle()
    // A layout-owner build pins through main first, as the tab bar does.
    const tabId = store.getState().unifiedTabsByWorktree['wt-1']![0]!.id
    const pin = (): void => store.getState().pinFile('/repo/a.ts')
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      withLayoutOwnerTabProps(
        {
          togglePinned: pin,
          makePreviewFilePermanent: (fileId, tab) =>
            store.getState().makePreviewFilePermanent(fileId, tab)
        },
        () => 'wt-1'
      ).togglePinned({
        unifiedTabId: tabId,
        isPinned: false,
        type: 'editor',
        data: { id: '/repo/a.ts' }
      })
    } else {
      pin()
    }
    await main.settle()

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })
    await main.settle()

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
        isPinned: true
      }),
      expect.objectContaining({
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    // Not a preview: a switch-on build omits the flag rather than writing false.
    expect(store.getState().unifiedTabsByWorktree['wt-1']?.[0]?.isPreview).toBe(
      ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : false
    )
  })

  it('does not replace a dirty file that was opened as a preview', async () => {
    const store = createEditorTabsStore()
    const main = await drawTabsFromMain(store)

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
    await main.settle()
    store.getState().markFileDirty('/repo/a.ts', true)
    await main.settle()

    store.getState().openDiff('wt-1', '/repo/b.ts', 'b.ts', 'typescript', false, { preview: true })
    await main.settle()

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
        entityId: '/repo/a.ts'
      }),
      expect.objectContaining({
        entityId: 'wt-1::diff::unstaged::b.ts',
        isPreview: true
      })
    ])
    // Not a preview: a switch-on build omits the flag rather than writing false.
    expect(store.getState().unifiedTabsByWorktree['wt-1']?.[0]?.isPreview).toBe(
      ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : false
    )
  })
})
