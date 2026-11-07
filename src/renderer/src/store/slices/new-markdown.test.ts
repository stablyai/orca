import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { BrowserTab } from '../../../../shared/browser-workspace-types'

import './store-session-test-harness'
import { createEditorTabsStore } from './editor/editor-slice-test-harness'
import '@/runtime/layout-apply-test-transport.test-fixture'
import '../../../../shared/layout-owner-switch'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

function createEditorStore(overrides?: Partial<AppState>): StoreApi<AppState> {
  const store = createEditorTabsStore()
  store.setState(overrides ?? {})
  return store
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

describe('New Markdown — tab bar ordering with openFile', () => {
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
    expect(order.indexOf('t1')).toBeLessThan(order.indexOf('b1'))
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('t2'))
    expect(order.indexOf('t2')).toBeLessThan(order.indexOf('b2'))
    expect(order.at(-1)).toBe('/repo/untitled.md')
  })
})

describe('Tab close — tabBarOrderByWorktree cleanup', () => {
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

    store.getState().closeFile('/repo/b.md')
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([
      't1',
      'b1',
      '/repo/a.md',
      '/repo/c.md'
    ])

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
})
