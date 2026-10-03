// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTerminalWorkspaceProjection } from './use-terminal-workspace-projection'
import type { TerminalWorkspaceStoreController } from './use-terminal-workspace-store-bindings'
import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'

vi.mock('../store', () => ({ useAppStore: (selector: (s: unknown) => unknown) => selector({}) }))
vi.mock('../../../shared/feature-interactions', () => ({ hasFeatureInteraction: () => false }))
vi.mock('@/lib/foreground-terminal-tabs', () => ({ setForegroundTerminalTabIds: () => {} }))
vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () => ({
  useClientHostedBrowserRows: () => []
}))
vi.mock('./terminal/use-terminal-provider-snapshot-capability', () => ({
  useTerminalProviderSnapshotCapability: () => 0
}))
vi.mock('./terminal/split-group-mount', () => ({ getEffectiveLayoutForWorktree: () => undefined }))
vi.mock('./contextual-tours/use-contextual-tour', () => ({ useContextualTour: () => {} }))
vi.mock('./terminal/use-worktree-files', () => ({ useWorktreeFiles: () => [] }))

type BrowserTabsByWorktree = TerminalWorkspaceStoreController['browserTabsByWorktree']

function browserTab(id: string): BrowserWorkspace {
  return {
    id,
    worktreeId: 'wt-1',
    url: `https://example.test/${id}`,
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

function controllerFor(
  browserTabsByWorktree: BrowserTabsByWorktree,
  renderedActiveWorktreeId: string | null
): TerminalWorkspaceStoreController {
  const controller = {
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabType: 'terminal',
    activeView: 'terminal',
    activeWorktreeId: null,
    activityTerminalPortals: [],
    browserTabsByWorktree,
    ensureWorktreeRootGroup: () => {},
    groupsByWorktree: {},
    hydrationSucceeded: true,
    layoutByWorktree: {},
    openFiles: [],
    renderedActiveWorktreeId,
    tabsByWorktree: {},
    workspaceSessionReady: true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook destructures exactly the keys set above; any other member it grew would surface as an undefined destructure, not a silently wrong result.
  return controller as unknown as TerminalWorkspaceStoreController
}

describe('useTerminalWorkspaceProjection worktreeBrowserTabs identity', () => {
  // Why these three: each is a distinct path to the fallback, and a fix that
  // only stabilises one of them still churns the other two.
  const cases: [string, BrowserTabsByWorktree, string | null][] = [
    ['a worktree with no entry in the map', {}, 'wt-1'],
    ['a worktree whose entry is absent while others exist', { other: [browserTab('b1')] }, 'wt-1'],
    ['no rendered worktree at all', { 'wt-1': [browserTab('b1')] }, null]
  ]
  it.each(cases)('keeps one reference across re-renders for %s', (_name, map, worktreeId) => {
    const controller = controllerFor(map, worktreeId)
    const { result, rerender } = renderHook(() => useTerminalWorkspaceProjection(controller))

    const first = result.current.worktreeBrowserTabs
    rerender()
    rerender()

    expect(result.current.worktreeBrowserTabs).toBe(first)
    expect(result.current.worktreeBrowserTabs).toEqual([])
  })

  it('still hands back the real array when the worktree has tabs', () => {
    const tabs = [browserTab('b1'), browserTab('b2')]
    const controller = controllerFor({ 'wt-1': tabs }, 'wt-1')
    const { result, rerender } = renderHook(() => useTerminalWorkspaceProjection(controller))

    const first = result.current.worktreeBrowserTabs
    rerender()

    expect(first).toBe(tabs)
    expect(result.current.worktreeBrowserTabs).toBe(tabs)
    expect(result.current.activeWorktreeBrowserTabIdsKey).toBe('b1,b2')
  })
})
