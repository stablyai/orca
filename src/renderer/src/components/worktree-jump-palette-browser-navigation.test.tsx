// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { Suspense, useMemo } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCmdJBrowserNavigationAction } from './cmd-j/browser-navigation-action'
import {
  CREATE_WORKTREE_ITEM_ID,
  createWorktreePaletteRequestGuard
} from '@/lib/worktree-palette-create-action'
import { parseCmdJTaskSourceUrl } from '@/lib/worktree-palette-task-url-match'
import { useAppStore } from '@/store'
import { useWorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { useWorktreeJumpPaletteListEntries } from './use-worktree-jump-palette-list-entries'
import {
  makeRecentTabState,
  makeRepo,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree
} from './worktree-jump-palette-test-fixtures'
import type { QuickActionPaletteItem } from './worktree-jump-palette-model'

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

const { openWorkspaceBrowserTab } = vi.hoisted(() => ({ openWorkspaceBrowserTab: vi.fn() }))
vi.mock(import('@/lib/workspace-browser-tab-open'), async (importOriginal) => ({
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
  it('offers the website once as the first selectable row without an empty actions section', () => {
    const { result } = renderHook(() => useWorktreeJumpPaletteListEntries(listInput('brex.com')))

    expect(result.current.listEntries.map((entry) => entry.id)).toEqual([
      'quick-action:navigate-to-url',
      CREATE_WORKTREE_ITEM_ID
    ])
    expect(result.current.selectionItemIds[0]).toBe('quick-action:navigate-to-url')
  })

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

  it('leads weaker workspace and tab matches even when both sections are present', async () => {
    const state = useAppStore.getState()
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree('wt-alpha', 'Alpha workspace'),
          makeWorktree('wt-beta', 'project.development workspace')
        ]
      },
      tabsByWorktree: {
        ...state.tabsByWorktree,
        'wt-beta': [makeTerminalTab('term-beta', 'wt-beta', 'project.development terminal')]
      },
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        'wt-beta': [
          makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', 'project.development terminal')
        ]
      }
    })
    const { result } = renderHook(usePalette)

    await act(async () => result.current.handleQueryChange('project.dev'))

    expect(result.current.paletteSections.multiPrimaryFirstScreen).toBe(true)
    expect(result.current.commandSelectedItemId).toBe('quick-action:navigate-to-url')
    expect(result.current.selectableItems[0]?.id).toBe('quick-action:navigate-to-url')
  })

  it.each([
    ['brex.com', 'url'],
    ['new browser tab', 'blank']
  ] as const)(
    'shows a browser creation failure for %s without an unhandled rejection',
    async (query, tabKind) => {
      const showError = vi.spyOn(toast, 'error').mockReturnValue('browser-error')
      const openBrowser = vi.fn().mockRejectedValue(new Error('Browser host disconnected'))
      openWorkspaceBrowserTab.mockRejectedValue(new Error('Browser host disconnected'))
      const recordInteraction = vi.fn()
      useAppStore.setState({
        openNewBrowserTabInActiveWorkspace: openBrowser,
        recordFeatureInteraction: recordInteraction
      })
      const { result } = renderHook(usePalette)
      await act(async () => result.current.handleQueryChange(query))
      const action = result.current.selectableItems.find((item) => item.type === 'quick-action')
      if (!action) {
        throw new Error('Expected a browser action')
      }

      await act(async () => result.current.handleSelectItem(action))

      expect(tabKind === 'url' ? openWorkspaceBrowserTab : openBrowser).toHaveBeenCalledOnce()
      expect(showError).toHaveBeenCalledExactlyOnceWith('Browser host disconnected')
      expect(recordInteraction).not.toHaveBeenCalledWith('cmd-j-quick-action')
    }
  )

  describe.each(['worktree', 'workspace-tab', 'browser-page'] as const)(
    '%s name priority',
    (type) => {
      it.each(['project.dev', 'project.dev server'])(
        'gives only a full name match priority over website creation (%s)',
        async (name) => {
          if (type === 'worktree') {
            useAppStore.setState({
              worktreesByRepo: {
                'repo-1': [
                  makeWorktree('wt-alpha', 'Alpha workspace'),
                  makeWorktree('wt-beta', name)
                ]
              }
            })
          } else if (type === 'workspace-tab') {
            const state = useAppStore.getState()
            useAppStore.setState({
              tabsByWorktree: {
                ...state.tabsByWorktree,
                'wt-beta': [makeTerminalTab('term-beta', 'wt-beta', name)]
              },
              unifiedTabsByWorktree: {
                ...state.unifiedTabsByWorktree,
                'wt-beta': [makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', name)]
              }
            })
          } else {
            useAppStore.getState().createBrowserTab('wt-beta', 'https://example.com/', {
              title: name
            })
          }
          const { result } = renderHook(usePalette)

          await act(async () => result.current.handleQueryChange('project.dev'))

          const selected = result.current.selectableItems.find(
            (item) => item.id === result.current.commandSelectedItemId
          )
          expect(selected?.type).toBe(name === 'project.dev' ? type : 'quick-action')
          if (name !== 'project.dev') {
            expect(selected?.id).toBe('quick-action:navigate-to-url')
          }
          expect(result.current.middleLeadsSections).toBe(false)
          expect(
            result.current.selectableItems.filter(
              (item) => item.id === 'quick-action:navigate-to-url'
            )
          ).toHaveLength(1)
        }
      )
    }
  )

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
