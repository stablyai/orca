import { describe, expect, it, vi, beforeEach } from 'vitest'
import '../../../../shared/constants'
import {
  createEditorStore,
  createEditorTabsStore,
  ownedEditorFileId
} from './editor-slice-test-harness'

import '../../runtime/runtime-compatibility-test-fixture'
import '../../runtime/runtime-rpc-client'
import type { Tab } from '../../../../shared/tab-types'
import { makeWorktree } from './store-test-helpers'

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

// Why: tabs are mirrored only from a paired server's workspace, which keeps today's close path.
const pairedServerWorktrees = {
  'repo-1': [
    makeWorktree({
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/repo',
      runtimeOwnerEnvironmentId: 'env-1'
    }),
    makeWorktree({
      id: 'wt-2',
      repoId: 'repo-1',
      path: '/other',
      runtimeOwnerEnvironmentId: 'env-1'
    })
  ]
}

function mirroredEditorUnifiedTab(id: string, entityId: string, worktreeId: string): Tab {
  return {
    id,
    entityId,
    worktreeId,
    groupId: `${worktreeId}:group`,
    contentType: 'editor',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('createEditorSlice pending editor reveal', () => {
  it('clears pending reveal when closing all files in the active worktree', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setPendingEditorReveal({
      filePath: '/repo/src/file.ts',
      line: 42,
      column: 7,
      matchLength: 5
    })

    store.getState().closeAllFiles()

    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().pendingEditorReveal).toBeNull()
  })
})

describe('createEditorSlice editor drafts', () => {
  it('clears draft buffers when closing the file', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/src/file.ts', 'edited')

    store.getState().closeFile('/repo/src/file.ts')

    expect(store.getState().editorDrafts).toEqual({})
  })

  it('drops replaced preview drafts so hidden preview state cannot linger', () => {
    const store = createEditorStore()

    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().setEditorDraft('/repo/docs/README.md', 'draft')

    store.getState().openFile(
      {
        filePath: '/repo/docs/guide.md',
        relativePath: 'docs/guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )

    expect(store.getState().editorDrafts).toEqual({})
  })

  it('falls back to a browser tab when closing the last editor in the active worktree', () => {
    const store = createEditorStore()

    store.setState({
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { 'wt-1': 'browser-1' }
    })

    store.getState().openFile({
      filePath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    store.getState().closeFile('/repo/src/file.ts')

    expect(store.getState().activeTabType).toBe('browser')
    expect(store.getState().activeBrowserTabId).toBe('browser-1')
  })

  it('returns to the landing state when closing the last editor in a worktree with no other surfaces', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    store.getState().closeFile('/repo/notes.md')

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().activeFileId).toBeNull()
    expect(store.getState().activeBrowserTabId).toBeNull()
    expect(store.getState().activeTabType).toBe('terminal')
  })
})

describe('closeFile host mirroring', () => {
  beforeEach(() => {
    notifyHostOfMirroredEditorCloseMock.mockReset()
  })

  it('notifies the host for mirrored editors removed by close all in the active worktree', () => {
    const store = createEditorTabsStore()
    store.setState({ worktreesByRepo: pairedServerWorktrees })
    const a = store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit',
      mirroredFromRuntimeSession: true
    })
    const b = store.getState().openFile({
      filePath: '/other/b.ts',
      relativePath: 'b.ts',
      worktreeId: 'wt-2',
      language: 'typescript',
      mode: 'edit',
      mirroredFromRuntimeSession: true
    })
    store.setState({
      unifiedTabsByWorktree: {
        'wt-1': [mirroredEditorUnifiedTab('host-tab-a', a, 'wt-1')],
        'wt-2': [mirroredEditorUnifiedTab('host-tab-b', b, 'wt-2')]
      },
      tabBarOrderByWorktree: {
        'wt-1': ['host-tab-a'],
        'wt-2': ['host-tab-b']
      }
    })

    store.getState().closeAllFiles()

    // closeAllFiles bypasses closeFile; require host close hooks for every directly removed mirror.
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledTimes(1)
    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(expect.anything(), 'wt-1', a)
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.id).toBe(b)
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([])
    expect(store.getState().tabBarOrderByWorktree['wt-2']).toEqual(['host-tab-b'])
  })

  it('removes clean same-owner duplicate editor siblings and every linked tab', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const localFile = store.getState().openFiles[0]!
    const duplicateFileId = 'owner-duplicate-a.ts'
    store.setState({
      openFiles: [localFile, { ...localFile, id: duplicateFileId }],
      activeFileId: localFile.id,
      activeFileIdByWorktree: { 'wt-1': localFile.id },
      tabBarOrderByWorktree: { 'wt-1': [localFile.id, duplicateFileId] }
    })
    store.getState().createUnifiedTab('wt-1', 'editor', {
      id: 'local-editor-tab',
      entityId: localFile.id,
      label: 'a.ts',
      activate: false
    })
    store.getState().createUnifiedTab('wt-1', 'editor', {
      id: 'duplicate-editor-tab',
      entityId: duplicateFileId,
      label: 'a.ts',
      activate: false
    })

    store.getState().closeFile(localFile.id)

    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([])
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([])
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toHaveLength(1)
  })

  it('keeps a same-owner duplicate sibling with an unsaved draft', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const localFile = store.getState().openFiles[0]!
    const duplicateFileId = 'owner-duplicate-a.ts'
    store.setState({
      openFiles: [localFile, { ...localFile, id: duplicateFileId, isDirty: true }],
      editorDrafts: { [duplicateFileId]: 'unsaved draft' }
    })

    store.getState().closeFile(localFile.id)

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({ id: duplicateFileId, isDirty: true })
    ])
    expect(store.getState().editorDrafts).toEqual({ [duplicateFileId]: 'unsaved draft' })
  })

  it('keeps a same-owner duplicate sibling with an empty unsaved draft', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const localFile = store.getState().openFiles[0]!
    const duplicateFileId = 'owner-duplicate-a.ts'
    store.setState({
      openFiles: [localFile, { ...localFile, id: duplicateFileId, isDirty: false }],
      editorDrafts: { [duplicateFileId]: '' }
    })

    store.getState().closeFile(localFile.id)

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({ id: duplicateFileId, isDirty: false })
    ])
    expect(store.getState().editorDrafts).toEqual({ [duplicateFileId]: '' })
  })

  it('repairs an inactive worktree selection swept with duplicate siblings', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const localFile = store.getState().openFiles[0]!
    const duplicateFileId = 'owner-duplicate-a.ts'
    const remainingFile = {
      ...localFile,
      id: 'wt-1-remaining',
      filePath: '/repo/b.ts',
      relativePath: 'b.ts'
    }
    const activeElsewhere = {
      ...localFile,
      id: 'wt-2-active',
      filePath: '/other/c.ts',
      relativePath: 'c.ts',
      worktreeId: 'wt-2'
    }
    store.setState({
      openFiles: [localFile, { ...localFile, id: duplicateFileId }, remainingFile, activeElsewhere],
      activeFileId: activeElsewhere.id,
      activeWorktreeId: 'wt-2',
      activeFileIdByWorktree: { 'wt-1': duplicateFileId, 'wt-2': activeElsewhere.id }
    })

    store.getState().closeFile(localFile.id)

    expect(store.getState().activeFileId).toBe(activeElsewhere.id)
    expect(store.getState().activeFileIdByWorktree['wt-1']).toBe(remainingFile.id)
  })

  it('selects the immediate surviving neighbor after sweeping duplicate siblings', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const localFile = store.getState().openFiles[0]!
    const duplicateBefore = {
      ...localFile,
      id: 'duplicate-before'
    }
    const duplicateAfter = { ...localFile, id: 'duplicate-after' }
    const leftFile = {
      ...localFile,
      id: 'left-file',
      filePath: '/repo/left.ts',
      relativePath: 'left.ts'
    }
    const nextFile = {
      ...localFile,
      id: 'next-file',
      filePath: '/repo/next.ts',
      relativePath: 'next.ts'
    }
    const laterFile = {
      ...localFile,
      id: 'later-file',
      filePath: '/repo/later.ts',
      relativePath: 'later.ts'
    }
    store.setState({
      openFiles: [leftFile, duplicateBefore, localFile, duplicateAfter, nextFile, laterFile],
      activeFileId: localFile.id,
      activeFileIdByWorktree: { 'wt-1': localFile.id }
    })

    store.getState().closeFile(localFile.id)

    expect(store.getState().activeFileId).toBe(nextFile.id)
    expect(store.getState().activeFileIdByWorktree['wt-1']).toBe(nextFile.id)
  })

  it('does not collapse similarly named files owned by external SSH targets', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/tmp/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      externalSshTargetId: 'ssh-a',
      mode: 'edit'
    })
    const sshAFile = store.getState().openFiles[0]!
    const sshBFile = {
      ...sshAFile,
      id: 'ssh-b-file',
      externalSshTargetId: 'ssh-b'
    }
    store.setState({ openFiles: [sshAFile, sshBFile] })

    store.getState().closeFile(sshAFile.id)

    expect(store.getState().openFiles).toEqual([sshBFile])
  })

  it('retains a clean duplicate sibling owned by another runtime environment', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const localFile = store.getState().openFiles[0]!
    const remoteOwnedFile = {
      ...localFile,
      id: ownedEditorFileId('/repo/a.ts', 'wt-1', 'remote-1'),
      runtimeEnvironmentId: 'remote-1'
    }
    store.setState({ openFiles: [localFile, remoteOwnedFile] })

    store.getState().closeFile(localFile.id)

    expect(store.getState().openFiles).toEqual([remoteOwnedFile])
  })
})
