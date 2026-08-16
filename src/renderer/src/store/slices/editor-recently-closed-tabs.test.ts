import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import {
  createEditorStore,
  createEditorTabsStore,
  ownedEditorFileId
} from './editor-slice-test-harness'
import type { AppState } from '../types'
import type { Tab } from '../../../../shared/tab-types'

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

/** Counts how often store code reads `entityId` off a worktree's unified tabs —
 *  a scan-count proxy that pins complexity without timing the wall clock. */
function withCountedEntityIdReads(tabs: readonly Tab[], onRead: () => void): Tab[] {
  return tabs.map((tab) => {
    const { entityId, ...rest } = tab
    return Object.defineProperty(rest, 'entityId', {
      get: () => {
        onRead()
        return entityId
      },
      enumerable: true,
      configurable: true
    }) as Tab
  })
}

describe('createEditorSlice recently closed editor tabs', () => {
  function openMirroredEditor(store: StoreApi<AppState>, filePath: string, preview = false): void {
    store.getState().openFile(
      {
        filePath,
        relativePath: filePath.replace('/repo/', ''),
        worktreeId: 'wt-1',
        language: 'markdown',
        runtimeEnvironmentId: 'env-1',
        mirroredFromRuntimeSession: true,
        mode: 'edit'
      },
      { preview }
    )
  }

  it('reopens a closed mirrored editor tab as a local tab', () => {
    const store = createEditorStore()
    openMirroredEditor(store, '/repo/notes.md')

    store.getState().closeFile('/repo/notes.md')

    const recent = store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]
    expect(recent).toMatchObject({ filePath: '/repo/notes.md' })
    expect(recent).not.toHaveProperty('mirroredFromRuntimeSession')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles[0]).toMatchObject({ filePath: '/repo/notes.md' })
    expect(store.getState().openFiles[0]).not.toHaveProperty('mirroredFromRuntimeSession')
  })

  it('reopens close-all mirrored editor tabs as local tabs', () => {
    const store = createEditorStore()
    openMirroredEditor(store, '/repo/notes.md')

    store.getState().closeAllFiles()

    const recent = store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]
    expect(recent).toMatchObject({ filePath: '/repo/notes.md' })
    expect(recent).not.toHaveProperty('mirroredFromRuntimeSession')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles[0]).toMatchObject({ filePath: '/repo/notes.md' })
    expect(store.getState().openFiles[0]).not.toHaveProperty('mirroredFromRuntimeSession')
  })

  it('reopens replaced mirrored preview tabs as local tabs', () => {
    const store = createEditorStore()
    openMirroredEditor(store, '/repo/notes.md', true)

    store.getState().openFile(
      {
        filePath: '/repo/guide.md',
        relativePath: 'guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        runtimeEnvironmentId: 'env-1',
        mode: 'edit'
      },
      { preview: true, recordReplacedPreview: true }
    )

    const recent = store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]
    expect(recent).toMatchObject({ filePath: '/repo/notes.md' })
    expect(recent).not.toHaveProperty('mirroredFromRuntimeSession')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles.at(-1)).toMatchObject({ filePath: '/repo/notes.md' })
    expect(store.getState().openFiles.at(-1)).not.toHaveProperty('mirroredFromRuntimeSession')
  })

  it('restores the exact same-path owner instead of moving the local editor', () => {
    const store = createEditorTabsStore()
    const localId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    const remoteId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      runtimeEnvironmentId: 'env-1',
      mode: 'edit'
    })
    store.getState().setTabBarOrder('wt-1', [localId, remoteId])

    store.getState().closeFile(remoteId)
    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    const openIds = store.getState().openFiles.map((file) => file.id)
    expect(openIds).toEqual([localId, remoteId])
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([localId, remoteId])
  })

  it('keeps same-path edit and diff tabs as separate entities on reopen', () => {
    const store = createEditorTabsStore()
    const editId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openDiff('wt-1', '/repo/notes.md', 'notes.md', 'markdown', false)
    const diffId = 'wt-1::diff::unstaged::notes.md'
    store.getState().setTabBarOrder('wt-1', [editId, diffId])

    store.getState().closeFile(diffId)
    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([editId, diffId])
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([editId, diffId])
  })

  it('keeps close-all editor snapshots positioned for reopen', () => {
    const store = createEditorTabsStore()
    const firstId = store.getState().openFile({
      filePath: '/repo/first.md',
      relativePath: 'first.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    const middleId = store.getState().openFile({
      filePath: '/repo/middle.md',
      relativePath: 'middle.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    const lastId = store.getState().openFile({
      filePath: '/repo/last.md',
      relativePath: 'last.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().setTabBarOrder('wt-1', [firstId, middleId, lastId])

    store.getState().closeAllFiles()
    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles[0]?.id).toBe(firstId)
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([firstId])
  })

  it('captures close-all snapshot positions without rescanning tab state per closed tab', () => {
    const countEntityIdReads = (fileCount: number): number => {
      const store = createEditorTabsStore()
      for (let index = 0; index < fileCount; index += 1) {
        store.getState().openFile(
          {
            filePath: `/repo/file-${index}.ts`,
            relativePath: `file-${index}.ts`,
            worktreeId: 'wt-1',
            language: 'typescript',
            mode: 'edit'
          },
          { preview: false }
        )
      }
      let reads = 0
      store.setState({
        unifiedTabsByWorktree: {
          'wt-1': withCountedEntityIdReads(
            store.getState().unifiedTabsByWorktree['wt-1'] ?? [],
            () => {
              reads += 1
            }
          )
        }
      } as Partial<AppState>)
      reads = 0

      store.getState().closeAllFiles()

      expect(store.getState().openFiles).toHaveLength(0)
      expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]?.position).toEqual({
        tabBarIndex: 0,
        groupId: expect.any(String),
        groupIndex: 0
      })
      return reads
    }

    // Why: resolving each closed tab's position by rescanning tab order and group membership
    // made close-all cubic — 4x the tabs cost ~64x the scans and froze the renderer for seconds.
    expect(countEntityIdReads(80)).toBeLessThanOrEqual(countEntityIdReads(20) * 8)
  })

  it('reactivates the live tab when a stale reopen id targets an already-open file', () => {
    const store = createEditorTabsStore()
    store.setState({
      worktreesByRepo: {
        'repo-1': [
          { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
          { id: 'wt-2', repoId: 'repo-1', path: '/repo-2' }
        ]
      }
    } as unknown as Partial<AppState>)
    const sharedPath = '/home/me/.zshrc'
    const openShared = (worktreeId: string): string =>
      store.getState().openFile({
        filePath: sharedPath,
        relativePath: '.zshrc',
        worktreeId,
        language: 'shell',
        mode: 'edit'
      })

    // Bare path id: nothing else owns this path yet.
    const staleWt1Id = openShared('wt-1')
    expect(staleWt1Id).toBe(sharedPath)
    store.getState().closeFile(staleWt1Id)

    // wt-2 claims the bare id, so wt-1's reopen gets a namespaced id instead.
    const wt2Id = openShared('wt-2')
    expect(wt2Id).toBe(sharedPath)
    const liveWt1Id = openShared('wt-1')
    expect(liveWt1Id).toBe(ownedEditorFileId(sharedPath, 'wt-1', null))
    store.getState().closeFile(wt2Id)

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([liveWt1Id])
    expect(store.getState().activeFileId).toBe(liveWt1Id)
    expect(store.getState().activeFileIdByWorktree['wt-1']).toBe(liveWt1Id)
    expect(
      (store.getState().unifiedTabsByWorktree['wt-1'] ?? []).map((tab) => tab.entityId)
    ).toEqual([liveWt1Id])
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([liveWt1Id])
  })
})
