import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import '@/store/testing/app-store-test-fixture'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { buildBrowserPage } from '@/store/slices/browser/pages/browser-page-records'
import { captureLinkOpenIntent } from '../../links/placement/link-open-intent'
import { beginLinkOpenRequest } from '../../links/link-open-request'
import { openLocalBrowserLink } from './browser-link-open'
import { selectBrowserLinkDestination } from './browser-link-destination'
import {
  browserLinkTestDestination,
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from './browser-link-open.test-fixture'
import type { BrowserLinkTestStore } from './browser-link-open.test-fixture'
import {
  openWorkspaceBrowserTab,
  openWorkspaceBrowserTabForLink
} from '../workspace/workspace-browser-tab-open'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/input/browser-focus'

import {
  openOwnedHttpLink,
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from './http-link-routing'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { activateBrowserPagePaletteResult } from '../palette/browser-page-palette-activation'
import { openLinkedFileInEditor } from '@/components/terminal-pane/links/files/terminal-file-link-editor-open'
import { completePlacedBrowserLink } from '../workspace/placed-browser-link-completion'
import { beginPendingTab } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/components/browser-pane/host-guest/input/browser-focus', async (importOriginal) => ({
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

afterEach(() => vi.unstubAllGlobals())

describe('floating link review regressions', () => {
  beforeEach(() => {
    store.setState({
      settings: { ...getDefaultSettings('/home/test'), floatingTerminalEnabled: true },
      floatingWorkspacePanelOpen: true
    })
  })

  it('keeps the source repo profile when routing a local HTTP link into floating', async () => {
    store.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, browserProfileId: 'source-profile' }))
    }))
    registerHttpLinkStoreAccessor(() => store.getState())
    registerWorkspaceHttpLinkBrowserOpener(openWorkspaceBrowserTab)
    try {
      await new Promise<void>((resolve) => {
        openOwnedHttpLink(URL_TO_OPEN, {
          worktreeId: WORKSPACE,
          sourceOwner: { kind: 'local' },
          floatingWorkspace: true,
          forceInApp: true,
          onBrowserOpenComplete: () => resolve()
        })
      })
      const opened = Object.values(store.getState().browserTabsByWorktree)
        .flat()
        .find((tab) => tab.url === URL_TO_OPEN)
      expect(opened).toMatchObject({
        worktreeId: 'repo1::/repo',
        sessionProfileId: 'source-profile'
      })
    } finally {
      registerWorkspaceHttpLinkBrowserOpener(null)
    }
  })

  it('retains a placed browser when reconciling the floating workspace', () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    const created = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: false
    })
    store.getState().reconcileWorktreeTabModel(floating)
    expect(store.getState().unifiedTabsByWorktree[floating]).toEqual([
      expect.objectContaining({ entityId: created.id, contentType: 'browser' })
    ])
  })

  it('keeps the floating selection when a delayed link has lost foreground intent', async () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    const existing = store.getState().createBrowserTab(WORKSPACE, 'https://existing.example/', {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null
    })
    const outcome = await openWorkspaceBrowserTabForLink({
      workspaceId: WORKSPACE,
      placementWorkspaceId: floating,
      url: URL_TO_OPEN,
      intent: { kind: 'url' },
      linkContext: { linkIntent: null, canReveal: () => false }
    })
    expect(outcome).toMatchObject({ status: 'opened' })
    expect(store.getState().activeBrowserTabIdByWorktree[floating]).toBe(existing.id)
  })

  it('blocks floating palette activation before changing selection on a web client', () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    const existing = store.getState().createBrowserTab(WORKSPACE, 'https://existing.example/', {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null
    })
    const target = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: false
    })
    vi.stubGlobal('window', { ...window, __ORCA_WEB_CLIENT__: true })
    expect(
      activateBrowserPagePaletteResult({
        worktreeId: floating,
        workspaceId: target.id,
        pageId: target.activePageId!,
        executionHostId: 'local'
      })
    ).toEqual({ status: 'blocked' })
    expect(store.getState().activeBrowserTabIdByWorktree[floating]).toBe(existing.id)
  })

  it('refuses a floating file before creating a hidden document on a web client', () => {
    vi.stubGlobal('window', { ...window, __ORCA_WEB_CLIENT__: true })
    expect(
      openLinkedFileInEditor(
        {
          filePath: '/repo/report.md',
          relativePath: 'report.md',
          worktreeId: WORKSPACE
        },
        null,
        { line: null, column: null },
        () => true,
        'local'
      )
    ).toBeNull()
    expect(store.getState().openFiles).toEqual([])
  })

  it('selects the source terminal after closing its last local browser while a floating browser survives', () => {
    const source = browser('a')
    store.getState().createBrowserTab(WORKSPACE, 'https://floating.example/', {
      placementWorkspaceId: FLOATING_TERMINAL_WORKTREE_ID,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: false
    })
    store.getState().setActiveBrowserTab(source.id, WORKSPACE)
    store.getState().closeBrowserTab(source.id)
    expect(store.getState().activeBrowserTabIdByWorktree[WORKSPACE]).toBeNull()
    expect(store.getState().activeTabTypeByWorktree[WORKSPACE]).toBe('terminal')
  })

  it('waits for a pending floating browser before looking up its page', async () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    const created = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      placementWorkspaceId: floating,
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: false
    })
    const pages = store.getState().browserPagesByWorkspace[created.id]!
    const settle = beginPendingTab('pending-floating', floating, created.id, { kind: 'open' })
    store.setState({ browserPagesByWorkspace: {} })
    let outcome: unknown
    const opening = completePlacedBrowserLink(
      {
        workspaceId: WORKSPACE,
        placementWorkspaceId: floating,
        url: URL_TO_OPEN,
        intent: { kind: 'url' },
        focusOnCreate: false,
        onLinkOutcome: (result) => {
          outcome = result
        }
      },
      created.activePageId!,
      null,
      created.id
    )
    store.setState({ browserPagesByWorkspace: { [created.id]: pages } })
    settle('pending-floating')
    await opening
    expect(outcome).toMatchObject({
      status: 'opened',
      result: { browserPageId: created.activePageId }
    })
  })
})
