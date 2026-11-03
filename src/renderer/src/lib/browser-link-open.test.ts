import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { buildBrowserPage } from '@/store/slices/browser-page-records'
import { captureLinkOpenIntent } from './link-open-intent'
import { beginLinkOpenRequest } from './link-open-request'
import { openLocalBrowserLink } from './browser-link-open'
import { selectBrowserLinkDestination } from './browser-link-destination'
import {
  browserLinkTestDestination,
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN,
  type BrowserLinkTestStore
} from './browser-link-open.test-fixture'
import { openFileInBrowserTab } from './file-preview'
import { openWorkspaceBrowserTabForLink } from './workspace-browser-tab-open'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
createStoreCascadesMockApi()
let store: BrowserLinkTestStore

beforeEach(() => {
  store = createBrowserLinkTestStore()
  mocks.getState.mockImplementation(() => store.getState())
})

function context(explicit = false) {
  return {
    linkIntent: captureLinkOpenIntent(store.getState(), WORKSPACE, 'source', {
      explicitSourceGroup: explicit
    }),
    isCurrentRequest: beginLinkOpenRequest()
  }
}

function open(linkContext = context()) {
  return openLocalBrowserLink({
    destination: browserLinkTestDestination(),
    context: linkContext,
    url: URL_TO_OPEN,
    ownsRoute: () => true
  })
}

function browser(groupId: string, url = URL_TO_OPEN) {
  return store.getState().createBrowserTab(WORKSPACE, url, {
    targetGroupId: groupId,
    executionHostId: 'local',
    browserRuntimeEnvironmentId: null,
    sessionProfileId: null,
    activate: false
  })
}

describe('browser link placement and exact page activation', () => {
  it('prefers an old inactive nonadjacent match over a nearby browser without navigation or creation', async () => {
    store.getState().createBrowserTab(WORKSPACE, 'https://nearby.example/', {
      targetGroupId: 'b',
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: true
    })
    const existing = browser('c')
    store.getState().createBrowserPage(existing.id, 'https://other.example/', {
      activate: true,
      browserRuntimeEnvironmentId: null
    })
    const navigate = vi.spyOn(store.getState(), 'setBrowserPageUrl')
    const create = vi.spyOn(store.getState(), 'createBrowserTab')
    const result = await open()
    expect(result).toMatchObject({
      status: 'opened',
      result: {
        browserWorkspaceId: existing.id,
        browserPageId: existing.activePageId,
        groupId: 'c'
      }
    })
    expect(
      store.getState().browserTabsByWorktree[WORKSPACE]?.find((tab) => tab.id === existing.id)
        ?.activePageId
    ).toBe(existing.activePageId)
    expect(navigate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('reusing a page clears a pending address-bar request and focuses the page', async () => {
    const existing = browser('b')
    const pageId = existing.activePageId
    if (!pageId) {
      throw new Error('Expected page')
    }
    store.setState({
      pendingAddressBarFocusByPageId: { [pageId]: true },
      pendingAddressBarFocusByTabId: { [existing.id]: true, [pageId]: true }
    })
    expect(await open()).toMatchObject({ status: 'opened', result: { browserPageId: pageId } })
    expect(store.getState().pendingAddressBarFocusByPageId).toEqual({})
    expect(store.getState().pendingAddressBarFocusByTabId).toEqual({})
    expect(requestBrowserFocus).toHaveBeenLastCalledWith({ pageId, target: 'webview' })
  })

  it('rechecks a reused page after workspace activation without navigating it back', async () => {
    const existing = browser('b')
    const pageId = existing.activePageId
    if (!pageId) {
      throw new Error('Expected page')
    }
    const outcome = await openLocalBrowserLink({
      destination: browserLinkTestDestination(),
      context: context(),
      url: URL_TO_OPEN,
      ownsRoute: () => true,
      reveal: () => store.getState().setBrowserPageUrl(pageId, 'https://navigated-away.example/')
    })
    expect(outcome).toEqual({ status: 'refused' })
    expect(store.getState().browserPagesByWorkspace[existing.id]?.[0]?.url).toBe(
      'https://navigated-away.example/'
    )
    expect(store.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  })

  it('removes a newly created tab after an activation error while preserving existing tabs', async () => {
    const existing = browser('c', 'https://unrelated.example/')
    const before = store.getState()
    const outcome = await openLocalBrowserLink({
      destination: browserLinkTestDestination(),
      context: context(),
      url: URL_TO_OPEN,
      ownsRoute: () => true,
      reveal: () => {
        throw new Error('Workspace activation failed')
      }
    })

    expect(outcome).toEqual({ status: 'failed' })
    const state = store.getState()
    expect(state.browserTabsByWorktree[WORKSPACE]?.map((tab) => tab.id)).toEqual([existing.id])
    expect(state.browserPagesByWorkspace).toEqual(before.browserPagesByWorkspace)
    expect(state.unifiedTabsByWorktree[WORKSPACE]).toEqual(before.unifiedTabsByWorktree[WORKSPACE])
    expect(state.recentlyClosedBrowserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
  })

  it('follows source movement while an explicit request stays pinned', async () => {
    const automatic = context()
    store.setState({
      unifiedTabsByWorktree: {
        [WORKSPACE]: store
          .getState()
          .unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
            tab.id === 'source' ? { ...tab, groupId: 'b' } : tab
          )
      }
    })
    const moved = await open(automatic)
    expect(moved.status).toBe('opened')
    if (moved.status !== 'opened') {
      throw new Error('Expected open')
    }
    expect(moved.result.groupId).toBe('c')
    expect(store.getState().groupsByWorktree[WORKSPACE]).toHaveLength(3)
    const explicit = context(true)
    store.setState({
      unifiedTabsByWorktree: {
        [WORKSPACE]: store
          .getState()
          .unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
            tab.id === 'source' ? { ...tab, groupId: 'a' } : tab
          )
      }
    })
    expect(await open(explicit)).toMatchObject({ status: 'opened', result: { groupId: 'b' } })
  })

  it('uses destination defaults after the source closes, instead of its captured group', async () => {
    const captured = context()
    store.setState({
      unifiedTabsByWorktree: {
        [WORKSPACE]: store
          .getState()
          .unifiedTabsByWorktree[WORKSPACE]!.filter((tab) => tab.id !== 'source')
      }
    })
    const opened = await open(captured)
    expect(opened.status).toBe('opened')
    if (opened.status !== 'opened') {
      throw new Error('Expected open')
    }
    expect(opened.result.groupId).toBe('b')
    expect(store.getState().groupsByWorktree[WORKSPACE]).toHaveLength(3)
  })

  it('refuses an expired explicit group before creating records or activating a destination', async () => {
    const captured = context(true)
    store.setState({
      groupsByWorktree: {
        [WORKSPACE]: store
          .getState()
          .groupsByWorktree[WORKSPACE]!.filter((group) => group.id !== 'a')
      }
    })
    const create = vi.spyOn(store.getState(), 'createBrowserTab')
    expect(await open(captured)).toEqual({ status: 'refused' })
    expect(create).not.toHaveBeenCalled()
    expect(store.getState().browserPagesByWorkspace).toEqual({})
  })

  it('refuses at the unified mutation seam and removes the incomplete browser records', async () => {
    const captured = context(true)
    const createUnifiedTab = store.getState().createUnifiedTab
    store.setState({
      createUnifiedTab: (...args) => {
        store.setState({
          groupsByWorktree: {
            [WORKSPACE]: store
              .getState()
              .groupsByWorktree[WORKSPACE]!.filter((group) => group.id !== 'a')
          }
        })
        return createUnifiedTab(...args)
      }
    })
    expect(await open(captured)).toEqual({ status: 'refused' })
    expect(store.getState().browserPagesByWorkspace).toEqual({})
    expect(store.getState().browserTabsByWorktree[WORKSPACE] ?? []).toEqual([])
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[WORKSPACE]?.some((tab) => tab.contentType === 'browser')
    ).toBe(false)
  })
})

describe('opt-in reuse of an existing browser tab', () => {
  function singleGroupWithHiddenBrowser() {
    store.setState((state) => ({
      layoutByWorktree: { [WORKSPACE]: { type: 'leaf', groupId: 'a' } },
      groupsByWorktree: {
        [WORKSPACE]: state.groupsByWorktree[WORKSPACE]!.filter((group) => group.id === 'a')
      },
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.filter((tab) => tab.groupId === 'a')
      },
      activeGroupIdByWorktree: { [WORKSPACE]: 'a' }
    }))
    const existing = browser('a', 'https://other.example/')
    store.getState().activateTab('source')
    return existing
  }

  function enableReuse() {
    store.setState((state) => ({
      settings: { ...state.settings!, openLinksInExistingBrowserTab: true }
    }))
  }

  it('splits beside a lone group when the setting is off', async () => {
    const existing = singleGroupWithHiddenBrowser()
    const opened = await open()
    expect(opened.status).toBe('opened')
    expect(store.getState().groupsByWorktree[WORKSPACE]).toHaveLength(2)
    expect(store.getState().browserPagesByWorkspace[existing.id]?.[0]?.url).toBe(
      'https://other.example/'
    )
  })

  it('navigates the hidden browser tab in place instead of splitting', async () => {
    const existing = singleGroupWithHiddenBrowser()
    enableReuse()
    const create = vi.spyOn(store.getState(), 'createBrowserTab')
    expect(await open()).toMatchObject({
      status: 'opened',
      result: {
        browserWorkspaceId: existing.id,
        browserPageId: existing.activePageId,
        groupId: 'a'
      }
    })
    expect(create).not.toHaveBeenCalled()
    expect(store.getState().groupsByWorktree[WORKSPACE]).toHaveLength(1)
    expect(store.getState().browserPagesByWorkspace[existing.id]?.[0]?.url).toBe(
      'https://example.com/a#one'
    )
  })

  it('picks the most recently focused browser tab across groups', async () => {
    enableReuse()
    const older = browser('b', 'https://older.example/')
    const newer = browser('c', 'https://newer.example/')
    store.setState((state) => ({
      groupsByWorktree: {
        [WORKSPACE]: state.groupsByWorktree[WORKSPACE]!.map((group) =>
          group.id === 'a' ? group : { ...group, activeTabId: `terminal-${group.id}` }
        )
      },
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
          tab.entityId === older.id
            ? { ...tab, lastFocusedAt: 2 }
            : tab.entityId === newer.id
              ? { ...tab, lastFocusedAt: 1 }
              : tab
        )
      }
    }))
    expect(await open()).toMatchObject({
      status: 'opened',
      result: { browserWorkspaceId: older.id, groupId: 'b' }
    })
  })

  it('keeps an explicit open-in-this-group request on its own new tab', async () => {
    const existing = singleGroupWithHiddenBrowser()
    enableReuse()
    const opened = await open(context(true))
    expect(opened.status).toBe('opened')
    if (opened.status !== 'opened') {
      throw new Error('Expected open')
    }
    expect(opened.result.browserWorkspaceId).not.toBe(existing.id)
    expect(store.getState().browserPagesByWorkspace[existing.id]?.[0]?.url).toBe(
      'https://other.example/'
    )
  })
})

describe('existing open routes with link intent', () => {
  it('refuses a source owner that changed while HTTP routing was pending', async () => {
    const captured = context()
    const host = 'ssh:changed-owner'
    store.setState((state) => ({
      repos: state.repos.map((repo) => ({
        ...repo,
        executionHostId: host,
        connectionId: 'changed-owner'
      })),
      worktreesByRepo: {
        repo1: state.worktreesByRepo.repo1!.map((worktree) => ({ ...worktree, hostId: host }))
      },
      activeWorkspaceExecutionHostId: host
    }))
    expect(
      await openWorkspaceBrowserTabForLink({
        workspaceId: WORKSPACE,
        url: URL_TO_OPEN,
        intent: { kind: 'url' },
        linkContext: captured
      })
    ).toEqual({ status: 'refused' })
    expect(store.getState().browserPagesByWorkspace).toEqual({})
  })

  it('creates a pinned local HTML preview even when another group already shows the file', async () => {
    const filePath = '/repo/index.html'
    browser('b', 'file:///repo/index.html')
    const outcome = vi.fn()
    await new Promise((resolve) =>
      openFileInBrowserTab({
        filePath,
        worktreeId: WORKSPACE,
        linkContext: context(true),
        onLinkOutcome: (result) => {
          outcome(result)
          resolve(result)
        }
      })
    )
    expect(outcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'opened',
        result: expect.objectContaining({ groupId: 'a' })
      })
    )
    expect(store.getState().browserTabsByWorktree[WORKSPACE]).toHaveLength(2)
  })

  it('finds inactive document pages through page records rather than workspace mirrors', () => {
    const existing = browser('c', 'https://other.example/')
    const docLocation = {
      kind: 'workspace-doc' as const,
      worktreeId: WORKSPACE,
      filePath: '/repo/doc.html'
    }
    const doc = buildBrowserPage(
      existing.id,
      WORKSPACE,
      '',
      undefined,
      null,
      'inactive-doc',
      docLocation
    )
    store.setState({
      browserPagesByWorkspace: {
        ...store.getState().browserPagesByWorkspace,
        [existing.id]: [...store.getState().browserPagesByWorkspace[existing.id]!, doc]
      }
    })
    const selection = selectBrowserLinkDestination(
      store.getState(),
      browserLinkTestDestination({ resource: { kind: 'document', docLocation } }),
      context().linkIntent
    )
    expect(selection).toMatchObject({
      status: 'ready',
      groupId: 'c',
      match: { browserPageId: 'inactive-doc' }
    })
  })

  it('keeps floating browser activation inside its own layout and leaves the selected workspace alone', async () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    store.setState({
      groupsByWorktree: {
        ...store.getState().groupsByWorktree,
        [floating]: ['fa', 'fb'].map((id) =>
          makeTabGroup({
            id,
            worktreeId: floating,
            activeTabId: id === 'fa' ? 'floating-source' : null,
            tabOrder: id === 'fa' ? ['floating-source'] : []
          })
        )
      },
      unifiedTabsByWorktree: {
        ...store.getState().unifiedTabsByWorktree,
        [floating]: [
          makeUnifiedTab({
            id: 'floating-source',
            worktreeId: floating,
            groupId: 'fa',
            executionHostId: 'local',
            contentType: 'terminal'
          })
        ]
      },
      layoutByWorktree: {
        ...store.getState().layoutByWorktree,
        [floating]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'fa' },
          second: { type: 'leaf', groupId: 'fb' }
        }
      }
    })
    const result = await openLocalBrowserLink({
      destination: browserLinkTestDestination({ worktreeId: floating }),
      context: { linkIntent: captureLinkOpenIntent(store.getState(), floating, 'floating-source') },
      url: URL_TO_OPEN,
      ownsRoute: () => true
    })
    expect(result).toMatchObject({
      status: 'opened',
      result: { worktreeId: floating }
    })
    expect(store.getState().activeWorktreeId).toBe(WORKSPACE)
  })
})
