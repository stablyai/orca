// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { Suspense, useMemo } from 'react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCmdJBrowserNavigationAction } from '../cmd-j/browser-navigation-action'
import {
  CREATE_WORKTREE_ITEM_ID,
  createWorktreePaletteRequestGuard
} from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import { parseCmdJTaskSourceUrl } from '@/lib/workspace/search/worktrees/worktree-palette-task-url-match'
import { useAppStore } from '@/store/index'
import { useWorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { useWorktreeJumpPaletteListEntries } from './use-worktree-jump-palette-list-entries'
import { makeRecentTabState, makeRepo } from './worktree-jump-palette-test-fixtures'
import type { QuickActionPaletteItem } from './worktree-jump-palette-model'

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const { openWorkspaceBrowserTab } = vi.hoisted(() => ({ openWorkspaceBrowserTab: vi.fn() }))
vi.mock(import('@/lib/browser/workspace/workspace-browser-tab-open'), async (importOriginal) => ({
  ...(await importOriginal()),
  openWorkspaceBrowserTab
}))

const initialAppState = useAppStore.getInitialState()

type ListInput = Parameters<typeof useWorktreeJumpPaletteListEntries>[0]

function navigationItem(query: string): QuickActionPaletteItem {
  const action = buildCmdJBrowserNavigationAction(query)
  if (!action) {
    throw new Error(`Expected a navigable URL: ${query}`)
  }
  return {
    id: `quick-action:${action.id}`,
    type: 'quick-action',
    result: { ...action, order: 0, qualityClass: 'exact-intent' }
  }
}

function listInput(query: string, overrides: Partial<ListInput> = {}): ListInput {
  return {
    hasQuery: true,
    openTabsLeadSections: true,
    middleLeadsSections: true,
    recentTabShortcutIndexByItem: new Map(),
    recentTabShortcutIndexById: new Map(),
    digitShortcutModifiers: [],
    paletteSections: {
      hasExactEntityDestination: false,
      visibleWorktreeItems: [],
      worktreeOverflowCount: 0,
      visibleProjectTargetItems: [],
      projectTargetOverflowCount: 0,
      visibleMiddleItems: [navigationItem(query)],
      middleOverflowCount: 0,
      visibleOpenTabItems: [],
      openTabOverflowCount: 0,
      multiPrimaryFirstScreen: false,
      multiPrimaryLayout: null
    },
    showCreateAction: true,
    createWorktreeName: query,
    autoSelectedItemIdRef: { current: null },
    taskSourceUrl: null,
    handleExpandSection: vi.fn(),
    taskItems: [],
    ...overrides
  }
}

describe('Cmd+J website placement', () => {
  it('preserves issue/PR creation ahead of website navigation', () => {
    const query = 'https://github.com/acme/project/pull/42'
    const { result } = renderHook(() =>
      useWorktreeJumpPaletteListEntries(
        listInput(query, { taskSourceUrl: parseCmdJTaskSourceUrl(query) })
      )
    )

    expect(result.current.listEntries.map((entry) => entry.id)).toEqual([
      CREATE_WORKTREE_ITEM_ID,
      'quick-action:navigate-to-url'
    ])
  })
})

function usePalette() {
  const createLookupGuard = useMemo(() => createWorktreePaletteRequestGuard(), [])
  return useWorktreeJumpPaletteController({ visible: true, lingering: true, createLookupGuard })
}

describe('Cmd+J website selection', () => {
  beforeEach(() => {
    openWorkspaceBrowserTab.mockReset().mockResolvedValue(undefined)
    useAppStore.setState(
      {
        ...initialAppState,
        ...makeRecentTabState(),
        repos: [makeRepo()],
        activeWorktreeId: 'wt-alpha',
        activeModal: 'worktree-palette',
        closeModal: vi.fn(),
        openNewBrowserTabInActiveWorkspace: vi.fn().mockResolvedValue(undefined),
        prefetchWorktreeCreateBase: vi.fn().mockResolvedValue(undefined)
      },
      true
    )
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useAppStore.setState(initialAppState, true)
  })

  it('keeps the palette open when a deferred URL is stale, then opens the current URL', async () => {
    let blockDeferredQuery = true
    let resumeDeferredQuery = () => {}
    const pendingRender = new Promise<void>((resolve) => {
      resumeDeferredQuery = resolve
    })
    const { result } = renderHook(
      () => {
        const palette = usePalette()
        if (blockDeferredQuery && palette.deferredQuery === 'second.com') {
          throw pendingRender
        }
        return palette
      },
      { wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense> }
    )
    const { closeModal } = useAppStore.getState()

    await act(async () => result.current.handleQueryChange('first.com'))
    await act(async () => result.current.handleQueryChange('second.com'))

    expect(result.current.query).toBe('second.com')
    expect(result.current.deferredQuery).toBe('first.com')
    const staleAction = result.current.selectableItems[0]
    expect(staleAction?.type).toBe('quick-action')
    if (!staleAction) {
      throw new Error('Expected the previous URL action while results are deferred')
    }
    await act(async () => result.current.handleSelectItem(staleAction))

    expect(openWorkspaceBrowserTab).not.toHaveBeenCalled()
    expect(closeModal).not.toHaveBeenCalled()
    expect(result.current.skipRestoreFocusRef.current).toBe(false)

    await act(async () => {
      blockDeferredQuery = false
      resumeDeferredQuery()
    })
    const currentAction = result.current.selectableItems[0]
    if (!currentAction) {
      throw new Error('Expected the current URL action after results catch up')
    }
    await act(async () => result.current.handleSelectItem(currentAction))

    expect(closeModal).toHaveBeenCalledExactlyOnceWith()
    expect(openWorkspaceBrowserTab).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'wt-alpha',
      targetGroupId: 'group-wt-alpha',
      url: 'https://second.com/',
      intent: { kind: 'url' }
    })
  })
})
