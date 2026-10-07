import type { StoreApi } from 'zustand/vanilla'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { OpenFile } from './editor'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'

const live = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!live.store) {
        throw new Error('No test store')
      }
      return live.store.getState()
    }
  }
}))

let store: StoreApi<AppState>
let file: OpenFile

beforeEach(() => {
  store = createEditorTabsStore()
  live.store = store
  store.getState().openFile({
    filePath: '/repo/note.md',
    relativePath: 'note.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
  const opened = store.getState().openFiles[0]
  if (!opened) {
    throw new Error('Document did not open')
  }
  file = opened
})

afterEach(() => {
  live.store = null
  vi.unstubAllGlobals()
})

function addSibling(overrides: Partial<OpenFile> = {}): OpenFile {
  const sibling = { ...file, id: 'duplicate-record', ...overrides }
  store.setState({ openFiles: [...store.getState().openFiles, sibling] })
  store.getState().createUnifiedTab(sibling.worktreeId, 'editor', {
    id: 'duplicate-tab',
    entityId: sibling.id,
    label: 'note.md',
    activate: false
  })
  return sibling
}

function addSplitView(): void {
  const originalTab = store.getState().unifiedTabsByWorktree['wt-1'][0]
  if (!originalTab) {
    throw new Error('Document tab did not open')
  }
  const split = store
    .getState()
    .createUnifiedTabInSplit(
      'wt-1',
      'editor',
      { sourceGroupId: originalTab.groupId, splitDirection: 'right' },
      { id: 'second-pane-tab', entityId: file.id, label: 'note.md', activate: false }
    )
  expect(split?.groupId).toBeTruthy()
  expect(split?.groupId).not.toBe(originalTab.groupId)
  expect(store.getState().groupsByWorktree['wt-1']).toHaveLength(2)
}

describe('closing duplicate document records', () => {
  it('closes clean duplicate records for the same document owner', () => {
    addSibling()
    store.getState().closeFile(file.id)
    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([])
    expect(store.getState().groupsByWorktree['wt-1'][0]?.recentTabIds).toEqual([])
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toHaveLength(1)
  })

  it('removes both file and unified tab ids from the persisted tab order', () => {
    const sibling = addSibling()
    const tabIds = store.getState().unifiedTabsByWorktree['wt-1'].map((tab) => tab.id)
    store.setState({
      tabBarOrderByWorktree: { 'wt-1': [file.id, sibling.id, ...tabIds, 'survivor'] }
    })
    store.getState().closeFile(file.id)
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual(['survivor'])
  })

  it('document close removes every tab linked to that record', () => {
    addSplitView()
    store.getState().closeFile(file.id)
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([])
  })

  it('closing one pane tab preserves the document and its other view', () => {
    const originalTab = store.getState().unifiedTabsByWorktree['wt-1'][0]
    if (!originalTab) {
      throw new Error('Document tab did not open')
    }
    addSplitView()
    expect(
      dispatchWorkspaceTabCommand({
        type: 'close',
        target: { kind: 'tab', worktreeId: 'wt-1', tabId: originalTab.id }
      })
    ).toBe(true)
    expect(store.getState().openFiles).toEqual([file])
    expect(store.getState().unifiedTabsByWorktree['wt-1'].map((tab) => tab.id)).toEqual([
      'second-pane-tab'
    ])
  })

  it.each([undefined, '', 'divergent pending text'])(
    'preserves a dirty sibling draft: %s',
    (draft) => {
      const sibling = addSibling({ isDirty: draft === undefined })
      if (draft !== undefined) {
        store.setState({ editorDrafts: { [sibling.id]: draft } })
      }
      store.getState().closeFile(file.id)
      expect(store.getState().openFiles).toEqual([sibling])
      if (draft !== undefined) {
        expect(store.getState().editorDrafts[sibling.id]).toBe(draft)
      }
    }
  )

  it('preserves the same path on another runtime owner', () => {
    const sibling = addSibling({ runtimeEnvironmentId: 'other-runtime' })
    store.getState().closeFile(file.id)
    expect(store.getState().openFiles).toEqual([sibling])
  })

  it('preserves the same path on an external SSH target', () => {
    const sibling = addSibling({ externalSshTargetId: 'other-ssh' })
    store.getState().closeFile(file.id)
    expect(store.getState().openFiles).toEqual([sibling])
  })

  it('preserves the same path in another worktree', () => {
    const sibling = addSibling({ worktreeId: 'wt-2' })
    store.getState().closeFile(file.id)
    expect(store.getState().openFiles).toEqual([sibling])
  })

  it('preserves a sibling with different captured owner provenance', () => {
    const provenance = file.operationProvenance
    if (!provenance) {
      throw new Error('Owner provenance did not capture')
    }
    const sibling = addSibling({
      operationProvenance: {
        ...provenance,
        generation: { ...provenance.generation, runtimeConnectionGeneration: 9 }
      }
    })
    store.getState().closeFile(file.id)
    expect(store.getState().openFiles).toEqual([sibling])
  })

  it.each([{ readOnly: true }, { mode: 'diff' } as const])(
    'preserves another file mode or access type: %j',
    (overrides) => {
      const sibling = addSibling(overrides)
      store.getState().closeFile(file.id)
      expect(store.getState().openFiles).toEqual([sibling])
    }
  )

  it('closes a disconnected runtime document without requiring its worktree catalog', () => {
    const provenance = file.operationProvenance
    if (!provenance) {
      throw new Error('Owner provenance did not capture')
    }
    file = {
      ...file,
      runtimeEnvironmentId: 'offline-owner',
      operationProvenance: {
        ...provenance,
        generation: {
          ...provenance.generation,
          route: { executionHostId: 'runtime:offline-owner', runtimeEnvironmentId: 'offline-owner' }
        }
      }
    }
    store.setState({ openFiles: [file], worktreesByRepo: {}, runtimeEnvironments: [] })
    addSibling()
    const originalTab = store
      .getState()
      .unifiedTabsByWorktree['wt-1'].find((tab) => tab.entityId === file.id)
    if (!originalTab) {
      throw new Error('Document tab did not open')
    }
    expect(
      dispatchWorkspaceTabCommand({
        type: 'close',
        target: { kind: 'tab', worktreeId: 'wt-1', tabId: originalTab.id }
      })
    ).toBe(true)
    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([])
  })

  it.each([undefined, '', 'pending sibling text'])(
    'close-all preserves the backing file of a dirty duplicate: %s',
    async (draft) => {
      const stat = vi.fn(async () => ({ size: 0, isDirectory: false, mtime: 0 }))
      const deletePath = vi.fn(async () => {})
      vi.stubGlobal('window', { api: { fs: { stat, deletePath } } })
      file = { ...file, isUntitled: true }
      store.setState({ openFiles: [file] })
      const sibling = addSibling({ isDirty: draft === undefined })
      if (draft !== undefined) {
        store.setState({ editorDrafts: { [sibling.id]: draft } })
      }
      store.getState().closeAllFiles()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(stat).not.toHaveBeenCalled()
      expect(deletePath).not.toHaveBeenCalled()
      expect(store.getState().openFiles).toEqual([])
    }
  )

  it.each(['closeFile', 'closeAllFiles'] as const)(
    '%s retains the backing file when the selected untitled document has an empty draft',
    async (action) => {
      const stat = vi.fn(async () => ({ size: 0, isDirectory: false, mtime: 0 }))
      const deletePath = vi.fn(async () => {})
      vi.stubGlobal('window', { api: { fs: { stat, deletePath } } })
      store.setState({
        openFiles: [{ ...file, isUntitled: true }],
        editorDrafts: { [file.id]: '' }
      })
      if (action === 'closeFile') {
        store.getState().closeFile(file.id)
      } else {
        store.getState().closeAllFiles()
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(stat).not.toHaveBeenCalled()
      expect(deletePath).not.toHaveBeenCalled()
      expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toHaveLength(1)
    }
  )

  it.each(['closeFile', 'closeAllFiles'] as const)(
    '%s cancels placeholder deletion when its document reopens during stat',
    async (action) => {
      let finishStat:
        | ((value: { size: number; isDirectory: boolean; mtime: number }) => void)
        | undefined
      const stat = vi.fn(
        () =>
          new Promise<{ size: number; isDirectory: boolean; mtime: number }>((resolve) => {
            finishStat = resolve
          })
      )
      const deletePath = vi.fn(async () => {})
      vi.stubGlobal('window', { api: { fs: { stat, deletePath } } })
      store.setState({ openFiles: [{ ...file, isUntitled: true }] })
      if (action === 'closeFile') {
        store.getState().closeFile(file.id)
      } else {
        store.getState().closeAllFiles()
      }
      expect(stat).toHaveBeenCalledTimes(1)
      store.getState().openFile(file)
      if (!finishStat) {
        throw new Error('Stat did not start')
      }
      finishStat({ size: 0, isDirectory: false, mtime: 0 })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(deletePath).not.toHaveBeenCalled()
      expect(store.getState().openFiles).toHaveLength(1)
    }
  )

  it.each([
    'edit',
    'read-only',
    'diff',
    'old-generation',
    'external-ssh',
    'uncaptured-owner',
    'other-workspace'
  ] as const)(
    'keeps an untouched placeholder backing a surviving sibling draft: %s',
    async (view) => {
      const directory = await mkdtemp(join(tmpdir(), 'orca-close-draft-'))
      const targetPath = join(directory, 'untitled.md')
      const deletions: Promise<void>[] = []
      const deletePath = vi.fn(({ targetPath: path }: { targetPath: string }) => {
        const deletion = rm(path, { force: true })
        deletions.push(deletion)
        return deletion
      })
      vi.stubGlobal('window', {
        api: {
          fs: { stat: vi.fn(async () => ({ size: 0, isDirectory: false, mtime: 0 })), deletePath }
        }
      })
      try {
        await writeFile(targetPath, '')
        file = { ...file, filePath: targetPath, relativePath: 'untitled.md', isUntitled: true }
        if (view === 'external-ssh') {
          store.setState({
            repos: store.getState().repos.map((repo) => ({ ...repo, connectionId: 'same-ssh' })),
            sshConnectionStates: new Map([
              [
                'same-ssh',
                {
                  targetId: 'same-ssh',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: 7
                }
              ]
            ])
          })
          file = {
            ...file,
            externalSshTargetId: 'same-ssh',
            operationProvenance: captureEditorFileOperationProvenance(
              store.getState(),
              file.worktreeId,
              undefined,
              false
            )
          }
        }
        store.setState({ openFiles: [file] })
        const overrides: Partial<OpenFile> = { isDirty: true }
        if (view === 'other-workspace') {
          overrides.worktreeId = 'folder:overlapping-workspace'
        } else if (view === 'uncaptured-owner') {
          overrides.readOnly = true
          overrides.operationProvenance = undefined
        } else if (view === 'read-only') {
          overrides.readOnly = true
        } else if (view === 'diff') {
          overrides.mode = 'diff'
        } else if (view === 'old-generation') {
          const provenance = file.operationProvenance
          if (!provenance) {
            throw new Error('Owner provenance did not capture')
          }
          overrides.operationProvenance = {
            ...provenance,
            generation: { ...provenance.generation, runtimeConnectionGeneration: 9 }
          }
        }
        const sibling = addSibling(overrides)
        store.setState({ editorDrafts: { [sibling.id]: 'unsaved sibling text' } })
        store.getState().closeFile(file.id)
        await new Promise<void>((resolve) => setImmediate(resolve))
        await Promise.all(deletions)
        expect(deletePath).not.toHaveBeenCalled()
        expect(await readFile(targetPath, 'utf8')).toBe('')
        expect(store.getState().openFiles).toEqual([sibling])
        expect(store.getState().editorDrafts[sibling.id]).toBe('unsaved sibling text')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})
