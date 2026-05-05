/* eslint-disable max-lines */

import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it } from 'vitest'
import { createEditorSlice } from './editor'
import type { AppState } from '../types'
import type { BrowserTab, Tab, TabContentType, TabGroup } from '../../../../shared/types'

function createEditorStore(overrides?: Partial<AppState>): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    ...overrides,
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

function makeBrowserTab(id: string): BrowserTab {
  return {
    id,
    worktreeId: 'wt-1',
    url: 'about:blank',
    title: 'Browser',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

describe('New Markdown — isUntitled flag', () => {
  it('openFile preserves isUntitled when set', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    expect(store.getState().openFiles[0].isUntitled).toBe(true)
  })

  it('openFile defaults isUntitled to undefined when not set', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    expect(store.getState().openFiles[0].isUntitled).toBeUndefined()
  })

  it('clearUntitled removes the flag from the file', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    expect(store.getState().openFiles[0].isUntitled).toBe(true)

    store.getState().clearUntitled('/repo/untitled.md')
    expect(store.getState().openFiles[0].isUntitled).toBeUndefined()
  })

  it('clearUntitled does not affect other files', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    store.getState().openFile({
      filePath: '/repo/untitled-2.md',
      relativePath: 'untitled-2.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    store.getState().clearUntitled('/repo/untitled.md')
    expect(store.getState().openFiles[0].isUntitled).toBeUndefined()
    expect(store.getState().openFiles[1].isUntitled).toBe(true)
  })

  it('isUntitled survives re-opening the same file', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    // Re-open the same file (e.g. clicking it in explorer)
    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0].isUntitled).toBe(true)
  })
})

describe('New Markdown — tab bar ordering with openFile', () => {
  it('appends new file at the end of the tab order', () => {
    const store = createEditorStore({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      tabBarOrderByWorktree: { 'wt-1': ['t1'] }
    })

    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    const order = store.getState().tabBarOrderByWorktree['wt-1']
    expect(order.at(-1)).toBe('/repo/untitled.md')
  })

  it('appends after browser tabs (not before them)', () => {
    const store = createEditorStore({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [makeBrowserTab('b1')]
      },
      tabBarOrderByWorktree: { 'wt-1': ['t1', 'b1'] }
    })

    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    const order = store.getState().tabBarOrderByWorktree['wt-1']
    expect(order).toEqual(['t1', 'b1', '/repo/untitled.md'])
  })

  it('creating multiple files appends each at the end', () => {
    const store = createEditorStore({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [makeBrowserTab('b1')]
      },
      tabBarOrderByWorktree: { 'wt-1': ['t1', 'b1'] }
    })

    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    store.getState().openFile({
      filePath: '/repo/untitled-2.md',
      relativePath: 'untitled-2.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    const order = store.getState().tabBarOrderByWorktree['wt-1']
    expect(order).toEqual(['t1', 'b1', '/repo/untitled.md', '/repo/untitled-2.md'])
  })

  it('does not create duplicate entries in tab order', () => {
    const store = createEditorStore({
      tabBarOrderByWorktree: { 'wt-1': [] }
    })

    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    // Re-open the same file
    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    const order = store.getState().tabBarOrderByWorktree['wt-1']
    const occurrences = order.filter((id: string) => id === '/repo/untitled.md')
    expect(occurrences).toHaveLength(1)
  })

  it('does not disturb existing tab positions when adding a file', () => {
    const store = createEditorStore({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 't2',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 2',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [makeBrowserTab('b1'), makeBrowserTab('b2')]
      },
      tabBarOrderByWorktree: { 'wt-1': ['t1', 'b1', 't2', 'b2'] }
    })

    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    const order = store.getState().tabBarOrderByWorktree['wt-1']
    // Existing tabs should keep their original interleaved order
    expect(order.indexOf('t1')).toBeLessThan(order.indexOf('b1'))
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('t2'))
    expect(order.indexOf('t2')).toBeLessThan(order.indexOf('b2'))
    // New file at the end
    expect(order.at(-1)).toBe('/repo/untitled.md')
  })
})

describe('New Markdown — split group targeting', () => {
  it('opens into the explicitly requested group instead of the ambient active group', () => {
    const createdTabs: {
      worktreeId: string
      contentType: TabContentType
      entityId: string
      label: string
      targetGroupId?: string
    }[] = []
    const groups: TabGroup[] = [
      { id: 'group-a', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] },
      { id: 'group-b', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }
    ]
    const existingTabs: Tab[] = []
    const store = createEditorStore({
      groupsByWorktree: { 'wt-1': groups },
      unifiedTabsByWorktree: { 'wt-1': existingTabs },
      activeGroupIdByWorktree: { 'wt-1': 'group-a' },
      findTabForEntityInGroup: () => null,
      createUnifiedTab: (worktreeId, contentType, init) => {
        expect(init?.entityId).toBeTruthy()
        expect(init?.label).toBeTruthy()
        createdTabs.push({
          worktreeId,
          contentType,
          entityId: init!.entityId!,
          label: init!.label!,
          targetGroupId: init?.targetGroupId
        })
        return {
          id: 'tab-1',
          worktreeId,
          groupId: init?.targetGroupId ?? 'group-b',
          contentType,
          entityId: init?.entityId ?? '/repo/untitled.md',
          label: init?.label ?? 'untitled.md',
          customLabel: null,
          color: null,
          isPinned: false,
          isPreview: false,
          createdAt: 0,
          sortOrder: 0
        }
      }
    })

    store.getState().openFile(
      {
        filePath: '/repo/untitled.md',
        relativePath: 'untitled.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        isUntitled: true,
        mode: 'edit'
      },
      { preview: false, targetGroupId: 'group-b' }
    )

    expect(createdTabs).toEqual([
      {
        worktreeId: 'wt-1',
        contentType: 'editor',
        entityId: '/repo/untitled.md',
        label: 'untitled.md',
        targetGroupId: 'group-b'
      }
    ])
  })
})

describe('New Markdown — rename flow store operations', () => {
  it('closeFile + openFile simulates rename correctly', () => {
    const store = createEditorStore({
      tabBarOrderByWorktree: { 'wt-1': [] }
    })

    // Create untitled file
    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0].isUntitled).toBe(true)

    // Simulate rename: close old, open new
    store.getState().closeFile('/repo/untitled.md')
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0].id).toBe('/repo/notes.md')
    expect(store.getState().openFiles[0].isUntitled).toBeUndefined()
  })

  it('rename preserves active file to the new path', () => {
    const store = createEditorStore({
      tabBarOrderByWorktree: { 'wt-1': [] }
    })

    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    expect(store.getState().activeFileId).toBe('/repo/untitled.md')

    store.getState().closeFile('/repo/untitled.md')
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    expect(store.getState().activeFileId).toBe('/repo/notes.md')
  })

  it('closeFile clears editor draft for the old path', () => {
    const store = createEditorStore({
      tabBarOrderByWorktree: { 'wt-1': [] }
    })

    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/untitled.md', '# My notes')
    expect(store.getState().editorDrafts['/repo/untitled.md']).toBe('# My notes')

    store.getState().closeFile('/repo/untitled.md')
    expect(store.getState().editorDrafts['/repo/untitled.md']).toBeUndefined()
  })

  it('same-name save clears isUntitled via clearUntitled', () => {
    const store = createEditorStore({
      tabBarOrderByWorktree: { 'wt-1': [] }
    })

    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    expect(store.getState().openFiles[0].isUntitled).toBe(true)

    store.getState().clearUntitled('/repo/untitled.md')
    expect(store.getState().openFiles[0].isUntitled).toBeUndefined()
    // File should still exist
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0].id).toBe('/repo/untitled.md')
  })
})

describe('New Markdown — markFileDirty interaction', () => {
  it('new untitled file starts not dirty', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })
    expect(store.getState().openFiles[0].isDirty).toBe(false)
  })

  it('markFileDirty works on untitled files', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    store.getState().markFileDirty('/repo/untitled.md', true)
    expect(store.getState().openFiles[0].isDirty).toBe(true)

    store.getState().markFileDirty('/repo/untitled.md', false)
    expect(store.getState().openFiles[0].isDirty).toBe(false)
  })
})

describe('New Markdown — preview behavior', () => {
  it('opening untitled file with preview: false does not create a preview tab', () => {
    const store = createEditorStore()
    store.getState().openFile(
      {
        filePath: '/repo/untitled.md',
        relativePath: 'untitled.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        isUntitled: true,
        mode: 'edit'
      },
      { preview: false }
    )
    expect(store.getState().openFiles[0].isPreview).toBeUndefined()
  })
})

describe('Tab close — tabBarOrderByWorktree cleanup', () => {
  it('closeFile removes the file from tabBarOrderByWorktree', () => {
    const store = createEditorStore({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      tabBarOrderByWorktree: { 'wt-1': ['t1'] }
    })

    store.getState().openFile({
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toContain('/repo/file.md')

    store.getState().closeFile('/repo/file.md')
    expect(store.getState().tabBarOrderByWorktree['wt-1']).not.toContain('/repo/file.md')
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toContain('t1')
  })

  it('closeFile does not disturb other tab positions', () => {
    const store = createEditorStore({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 't2',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 2',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [makeBrowserTab('b1')]
      },
      tabBarOrderByWorktree: { 'wt-1': ['t1', 'b1', 't2'] }
    })

    store.getState().openFile({
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    // Order: t1, b1, t2, /repo/file.md
    store.getState().openFile({
      filePath: '/repo/file2.md',
      relativePath: 'file2.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    // Order: t1, b1, t2, /repo/file.md, /repo/file2.md

    store.getState().closeFile('/repo/file.md')
    const order = store.getState().tabBarOrderByWorktree['wt-1']
    expect(order).toEqual(['t1', 'b1', 't2', '/repo/file2.md'])
  })

  it('closing multiple files preserves remaining tab order', () => {
    const store = createEditorStore({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [makeBrowserTab('b1')]
      },
      tabBarOrderByWorktree: { 'wt-1': ['t1', 'b1'] }
    })

    store.getState().openFile({
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openFile({
      filePath: '/repo/b.md',
      relativePath: 'b.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openFile({
      filePath: '/repo/c.md',
      relativePath: 'c.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    // Close middle file
    store.getState().closeFile('/repo/b.md')
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([
      't1',
      'b1',
      '/repo/a.md',
      '/repo/c.md'
    ])

    // Close first file
    store.getState().closeFile('/repo/a.md')
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual(['t1', 'b1', '/repo/c.md'])
  })

  it('closeAllFiles removes all editor file IDs from tabBarOrderByWorktree', () => {
    const store = createEditorStore({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [makeBrowserTab('b1')]
      },
      tabBarOrderByWorktree: { 'wt-1': ['t1', 'b1'] }
    })

    store.getState().openFile({
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openFile({
      filePath: '/repo/b.md',
      relativePath: 'b.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    store.getState().closeAllFiles()
    const order = store.getState().tabBarOrderByWorktree['wt-1']
    expect(order).toEqual(['t1', 'b1'])
  })

  it('reopening a file after close places it at the end', () => {
    const store = createEditorStore({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 't1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Term 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [makeBrowserTab('b1')]
      },
      tabBarOrderByWorktree: { 'wt-1': ['t1', 'b1'] }
    })

    store.getState().openFile({
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openFile({
      filePath: '/repo/b.md',
      relativePath: 'b.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    // Close a.md, then reopen it — should go to the end
    store.getState().closeFile('/repo/a.md')
    store.getState().openFile({
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })

    const order = store.getState().tabBarOrderByWorktree['wt-1']
    expect(order).toEqual(['t1', 'b1', '/repo/b.md', '/repo/a.md'])
  })
})
