// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import { makeUnifiedTab, makeWorktree } from './worktree-jump-palette-test-fixtures'
import { useWorktreeJumpPaletteOpenTabs } from './use-worktree-jump-palette-open-tabs'

afterEach(cleanup)

it('keeps same-id browser results on their owner and updates when tab ownership changes', () => {
  const worktrees = [
    makeWorktree('same-id', 'Local workspace', { hostId: 'local' }),
    makeWorktree('same-id', 'Remote workspace', { hostId: 'runtime:paired' })
  ]
  const page: BrowserPage = {
    id: 'page',
    workspaceId: 'browser',
    worktreeId: 'same-id',
    url: 'https://example.test/docs',
    title: 'Browser proof',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
  const workspace: BrowserWorkspace = {
    ...page,
    id: 'browser',
    activePageId: page.id,
    pageIds: [page.id]
  }
  const tab: Tab = {
    ...makeUnifiedTab('tab', 'same-id', 'browser', 'Browser proof'),
    contentType: 'browser',
    executionHostId: 'runtime:paired'
  }
  type PaletteInput = Parameters<typeof useWorktreeJumpPaletteOpenTabs>[0]
  const input: Partial<PaletteInput> = {
    ...useAppStore.getInitialState(),
    workspacePortScan: null,
    paletteStatusInputsActive: true,
    allWorktrees: worktrees,
    browserSortedWorktrees: worktrees,
    repoMap: new Map(),
    repoByHostIdentity: new Map(),
    worktreeOrder: new Map(),
    worktreeMatches: [],
    hasQuery: true,
    deferredQuery: 'Browser proof',
    browserTabsByWorktree: { 'same-id': [workspace] },
    browserPagesByWorkspace: { browser: [page] },
    unifiedTabsByWorktree: { 'same-id': [tab] }
  }
  const { result, rerender } = renderHook(
    (props: Partial<PaletteInput>) => useWorktreeJumpPaletteOpenTabs(props as PaletteInput),
    { initialProps: input }
  )
  const owners = () =>
    result.current.browserItems.map(({ result: entry }) => [entry.pageId, entry.executionHostId])

  expect(owners()).toEqual([['page', 'runtime:paired']])

  rerender({
    ...input,
    unifiedTabsByWorktree: {
      'same-id': [{ ...tab, executionHostId: 'local' }]
    }
  })
  expect(owners()).toEqual([['page', 'local']])
})
