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
  it('opens beside the source despite focus in a nonadjacent group, returning the real identities', async () => {
    const result = await open()
    expect(result.status).toBe('opened')
    if (result.status !== 'opened') {
      throw new Error('Expected open')
    }
    const state = store.getState()
    expect(['a', 'b', 'c']).not.toContain(result.result.groupId)
    expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId).toBe(
      'source'
    )
    expect(
      state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === result.result.groupId)
        ?.activeTabId
    ).toBe(result.result.unifiedTabId)
    expect(state.browserPagesByWorkspace[result.result.browserWorkspaceId]?.[0]?.id).toBe(
      result.result.browserPageId
    )
    expect(state.pendingAddressBarFocusByPageId).toEqual({})
    expect(requestBrowserFocus).toHaveBeenLastCalledWith({
      pageId: result.result.browserPageId,
      target: 'webview'
    })
    expect(state.groupsByWorktree[WORKSPACE]).toHaveLength(4)
    expect(state.layoutByWorktree[WORKSPACE]).toMatchObject({
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'a' },
        second: { type: 'leaf', groupId: result.result.groupId }
      }
    })
    expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'b')?.activeTabId).toBe(
      'terminal-b'
    )
  })

  it('uses a distant visible browser and preserves the neighboring terminal', async () => {
    store.getState().createBrowserTab(WORKSPACE, 'https://unrelated.example/', {
      targetGroupId: 'c',
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: true
    })
    expect(await open()).toMatchObject({ status: 'opened', result: { groupId: 'c' } })
    expect(
      store.getState().groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId
    ).toBe('source')
  })

  it('prefers the focused visible browser, otherwise the most recently focused one', async () => {
    const left = browser('b', 'https://left.example/')
    const right = browser('c', 'https://right.example/')
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
          ...tab,
          lastFocusedAt: tab.entityId === left.id ? 200 : 100
        }))
      },
      groupsByWorktree: {
        [WORKSPACE]: state.groupsByWorktree[WORKSPACE]!.map((group) => ({
          ...group,
          activeTabId:
            state.unifiedTabsByWorktree[WORKSPACE]!.find(
              (tab) =>
                tab.entityId === (group.id === 'b' ? left.id : right.id) && tab.groupId === group.id
            )?.id ?? group.activeTabId
        }))
      },
      activeGroupIdByWorktree: { [WORKSPACE]: 'c' }
    }))
    expect(await open()).toMatchObject({ status: 'opened', result: { groupId: 'c' } })
    store.getState().focusGroup(WORKSPACE, 'a')
    const destination = browserLinkTestDestination({
      resource: { kind: 'website', url: 'https://another.example/' }
    })
    expect(
      selectBrowserLinkDestination(store.getState(), destination, context().linkIntent)
    ).toMatchObject({ groupId: 'c' })
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
          ...tab,
          lastFocusedAt: tab.entityId === left.id ? 1000 : 100
        }))
      }
    }))
    expect(
      selectBrowserLinkDestination(store.getState(), destination, context().linkIntent)
    ).toMatchObject({ groupId: 'b' })
  })

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

  it('reuses an exact match in the source group without creating another page', async () => {
    const existing = browser('a')
    const result = await open()
    expect(result).toMatchObject({ status: 'opened', result: { groupId: 'a' } })
    if (result.status !== 'opened') {
      throw new Error('Expected open')
    }
    expect(result.result.browserPageId).toBe(existing.activePageId)
    expect(store.getState().browserPagesByWorkspace[existing.id]?.[0]?.url).toBe(URL_TO_OPEN)
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

  it('retains a successfully created background tab without activating it', async () => {
    const outcome = await openLocalBrowserLink({
      destination: browserLinkTestDestination(),
      context: context(),
      url: URL_TO_OPEN,
      options: { activate: false },
      ownsRoute: () => true
    })

    expect(outcome.status).toBe('opened')
    if (outcome.status !== 'opened') {
      throw new Error('Expected open')
    }
    const state = store.getState()
    expect(state.browserTabsByWorktree[WORKSPACE]?.map((tab) => tab.id)).toEqual([
      outcome.result.browserWorkspaceId
    ])
    expect(state.browserPagesByWorkspace[outcome.result.browserWorkspaceId]?.[0]?.url).toBe(
      URL_TO_OPEN
    )
    expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  })

  it('uses the selected matching wrapper, then active page, instead of recency', async () => {
    browser('b')
    const selected = browser('b')
    const second = store.getState().createBrowserPage(selected.id, URL_TO_OPEN, {
      activate: true,
      browserRuntimeEnvironmentId: null
    })
    const wrapper = store
      .getState()
      .unifiedTabsByWorktree[WORKSPACE]?.find((tab) => tab.entityId === selected.id)
    if (!wrapper || !second) {
      throw new Error('Missing fixture')
    }
    store.getState().activateTab(wrapper.id, { worktreeId: WORKSPACE })
    expect(await open()).toMatchObject({
      status: 'opened',
      result: { unifiedTabId: wrapper.id, browserPageId: second.id }
    })
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
    expect(store.getState().layoutByWorktree[WORKSPACE]).toMatchObject({
      second: {
        first: { type: 'split', first: { groupId: 'b' }, second: { groupId: moved.result.groupId } }
      }
    })
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
    expect(store.getState().layoutByWorktree[WORKSPACE]).toMatchObject({
      second: {
        second: {
          type: 'split',
          first: { groupId: 'c' },
          second: { groupId: opened.result.groupId }
        }
      }
    })
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

  it('reuses in one group and does not create a split', async () => {
    store.setState({
      groupsByWorktree: { [WORKSPACE]: [store.getState().groupsByWorktree[WORKSPACE]![0]!] },
      layoutByWorktree: { [WORKSPACE]: { type: 'leaf', groupId: 'a' } }
    })
    const existing = browser('a')
    expect(await open()).toMatchObject({
      status: 'opened',
      result: { browserWorkspaceId: existing.id, groupId: 'a' }
    })
    expect(store.getState().groupsByWorktree[WORKSPACE]).toHaveLength(1)
  })

  it('supersedes a pending operation before creation', async () => {
    const captured = context()
    beginLinkOpenRequest()
    expect(await open(captured)).toEqual({ status: 'superseded' })
    expect(store.getState().browserPagesByWorkspace).toEqual({})
  })
})

describe('existing open routes with link intent', () => {
  it('opens local HTTP through the managed route and reports the exact destination', async () => {
    expect(
      await openWorkspaceBrowserTabForLink({
        workspaceId: WORKSPACE,
        url: URL_TO_OPEN,
        intent: { kind: 'url' },
        linkContext: context()
      })
    ).toMatchObject({
      status: 'opened',
      result: { worktreeId: WORKSPACE, executionHostId: 'local' }
    })
  })

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
