import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { BrowserTab } from '../../../../../../shared/browser-workspace-types'

import '../../../../i18n/i18n'
import { createEditorTabsStore } from '../editor-slice-test-harness'
import '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import '../../../../../../shared/layout-owner-switch'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
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
