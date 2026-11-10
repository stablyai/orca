import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import '@/store/testing/app-store-test-fixture'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { buildBrowserPage } from '@/store/slices/browser/pages/browser-page-records'
import { captureLinkOpenIntent } from '../../link-open-intent'
import { beginLinkOpenRequest } from '../../link-open-request'
import { openLocalBrowserLink } from './browser-link-open'
import { selectBrowserLinkDestination } from './browser-link-destination'
import {
  browserLinkTestDestination,
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN,
  type BrowserLinkTestStore
} from './browser-link-open.test-fixture'

import { openWorkspaceBrowserTabForLink } from '../workspace/workspace-browser-tab-open'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mocks.getState() } }))
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
