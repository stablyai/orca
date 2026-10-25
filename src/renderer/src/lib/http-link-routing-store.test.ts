import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { useAppStore } from '@/store'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { seedBrowserLinkTestStore, WORKSPACE, URL_TO_OPEN } from './browser-link-open.test-fixture'
import { captureLinkOpenIntent } from './link-open-intent'
import { openHttpLink } from './http-link-routing'
import { openRoutedHttpLink } from './http-link-destinations'
import * as workspaceBrowserTabOpen from './workspace-browser-tab-open'

const OTHER_WORKSPACE = 'repo1::/other'

vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))

beforeEach(() => {
  createStoreCascadesMockApi()
  seedBrowserLinkTestStore(useAppStore)
  useAppStore.setState({
    activeView: 'activity',
    settings: { ...getDefaultSettings('/home/test'), openLinksInApp: true }
  })
  useAppStore.setState((state) => ({
    worktreesByRepo: {
      repo1: [
        ...state.worktreesByRepo.repo1!,
        makeWorktree({ id: OTHER_WORKSPACE, repoId: 'repo1', path: '/other', hostId: 'local' })
      ]
    },
    tabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        id: tab.entityId,
        ptyId: null,
        worktreeId: WORKSPACE,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: tab.sortOrder,
        createdAt: tab.createdAt
      }))
    }
  }))
  vi.mocked(requestBrowserFocus).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function deferLocalhostRegistration() {
  const registration = Promise.withResolvers<{ url: string }>()
  const register = vi.fn(() => registration.promise)
  vi.stubGlobal('window', {
    ...window,
    api: { ...window.api, localhostWorktreeLabels: { register } }
  })
  useAppStore.setState((state) => ({
    settings: {
      ...(state.settings ?? getDefaultSettings('/home/test')),
      localhostWorktreeLabelsEnabled: true
    },
    workspacePortScansByKey: {
      'local:all': {
        platform: 'darwin',
        scannedAt: 1,
        ports: [
          {
            id: 'tcp:5180',
            kind: 'workspace',
            port: 5180,
            protocol: 'http',
            bindHost: '127.0.0.1',
            connectHost: 'localhost',
            owner: {
              repoId: 'repo1',
              worktreeId: WORKSPACE,
              displayName: 'main',
              path: '/repo',
              confidence: 'cwd'
            }
          }
        ]
      }
    }
  }))
  return { registration, register }
}

function observeBrowserLinkOpen() {
  const completed =
    Promise.withResolvers<
      Awaited<ReturnType<typeof workspaceBrowserTabOpen.openWorkspaceBrowserTabForLink>>
    >()
  const open = workspaceBrowserTabOpen.openWorkspaceBrowserTabForLink
  vi.spyOn(workspaceBrowserTabOpen, 'openWorkspaceBrowserTabForLink').mockImplementation(
    (request) => {
      const opening = open(request)
      void opening.then(completed.resolve, completed.reject)
      return opening
    }
  )
  return completed.promise
}

it.each([
  'unchanged',
  'workspace',
  'view',
  'host-return',
  'workspace-return',
  'view-return'
] as const)(
  'keeps a registered localhost tab but relinquishes foreground after navigation: %s',
  async (navigation) => {
    const { registration, register } = deferLocalhostRegistration()
    const completed = observeBrowserLinkOpen()
    openRoutedHttpLink('http://localhost:5180/', {
      worktreeId: WORKSPACE,
      sourceTabId: 'source',
      forceDestination: 'orca'
    })
    expect(register).toHaveBeenCalledOnce()
    expect(useAppStore.getState().browserPagesByWorkspace).toEqual({})

    if (navigation.startsWith('workspace')) {
      useAppStore.getState().setActiveWorktree(OTHER_WORKSPACE, 'local')
      if (navigation === 'workspace-return') {
        useAppStore.getState().setActiveWorktree(WORKSPACE, 'local')
      }
    } else if (navigation.startsWith('view')) {
      useAppStore.getState().setActiveView('skills')
      if (navigation === 'view-return') {
        useAppStore.getState().setActiveView('activity')
      }
    } else if (navigation === 'host-return') {
      useAppStore.setState({ activeWorkspaceExecutionHostId: 'ssh:other' })
      useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' })
    }
    const selected = useAppStore.getState()
    const labeledUrl = 'http://main.orca.localhost:60016/'
    registration.resolve({ url: labeledUrl })
    const outcome = await completed

    expect(outcome).toMatchObject({ status: 'opened' })
    if (outcome.status !== 'opened') {
      throw new Error('Expected the registered browser tab to be retained')
    }
    const state = useAppStore.getState()
    expect(state.browserPagesByWorkspace[outcome.result.browserWorkspaceId]?.[0]?.url).toBe(
      labeledUrl
    )
    expect(state.browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
    expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')?.activeTabId).toBe(
      'source'
    )
    expect(state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'b')?.activeTabId).toBe(
      'terminal-b'
    )
    if (navigation === 'unchanged') {
      expect(state.activeView).toBe('terminal')
      expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe(outcome.result.groupId)
      expect(requestBrowserFocus).toHaveBeenCalledExactlyOnceWith({
        pageId: outcome.result.browserPageId,
        target: 'webview'
      })
    } else {
      expect(state.activeWorktreeId).toBe(selected.activeWorktreeId)
      expect(state.activeWorkspaceExecutionHostId).toBe(selected.activeWorkspaceExecutionHostId)
      expect(state.activeView).toBe(selected.activeView)
      expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe(
        selected.activeGroupIdByWorktree[WORKSPACE]
      )
      expect(
        state.groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'b')?.activeTabId
      ).toBe('terminal-b')
      expect(requestBrowserFocus).not.toHaveBeenCalled()
    }
  }
)

it('lets a newer link open normally while an older localhost registration completes', async () => {
  const { registration, register } = deferLocalhostRegistration()
  const completed = observeBrowserLinkOpen()
  const options = {
    worktreeId: WORKSPACE,
    sourceTabId: 'source',
    forceDestination: 'orca' as const
  }
  openRoutedHttpLink('http://localhost:5180/', options)
  expect(register).toHaveBeenCalledOnce()
  openRoutedHttpLink(URL_TO_OPEN, options)
  const outcome = await completed
  expect(outcome).toMatchObject({ status: 'opened' })
  registration.resolve({ url: 'http://main.orca.localhost:60016/' })
  await registration.promise

  const state = useAppStore.getState()
  expect(state.browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
  expect(
    Object.values(state.browserPagesByWorkspace)
      .flat()
      .map((page) => page.url)
  ).toEqual([URL_TO_OPEN])
  expect(state.activeView).toBe('terminal')
  expect(requestBrowserFocus).toHaveBeenCalledOnce()
})

it.each(['workspace', 'view'] as const)(
  'retains a legacy localhost tab in the background after navigating to another %s',
  async (navigation) => {
    const { registration, register } = deferLocalhostRegistration()
    const completed = observeBrowserLinkOpen()
    openHttpLink('http://localhost:5180/', {
      worktreeId: WORKSPACE,
      sourceOwner: { kind: 'local' }
    })
    expect(register).toHaveBeenCalledOnce()
    if (navigation === 'workspace') {
      useAppStore.getState().setActiveWorktree(OTHER_WORKSPACE, 'local')
    } else {
      useAppStore.getState().setActiveView('skills')
    }
    const selected = useAppStore.getState()
    const labeledUrl = 'http://main.orca.localhost:60016/'
    registration.resolve({ url: labeledUrl })
    await completed

    const state = useAppStore.getState()
    expect(state.browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
    expect(
      Object.values(state.browserPagesByWorkspace)
        .flat()
        .map((page) => page.url)
    ).toEqual([labeledUrl])
    expect(state.activeWorktreeId).toBe(selected.activeWorktreeId)
    expect(state.activeView).toBe(selected.activeView)
    expect(state.activeGroupIdByWorktree[WORKSPACE]).toBe(
      selected.activeGroupIdByWorktree[WORKSPACE]
    )
    expect(requestBrowserFocus).not.toHaveBeenCalled()
  }
)

it.each([false, true])(
  'reveals the tab layout for a foreground source-aware HTTP link (reuse: %s)',
  async (reuse) => {
    if (reuse) {
      useAppStore.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
        targetGroupId: 'b',
        activate: false,
        browserRuntimeEnvironmentId: null,
        sessionProfileId: null
      })
    }
    const opening = vi.spyOn(workspaceBrowserTabOpen, 'openWorkspaceBrowserTabForLink')
    openHttpLink(URL_TO_OPEN, {
      worktreeId: WORKSPACE,
      sourceOwner: { kind: 'local' },
      linkContext: {
        linkIntent: captureLinkOpenIntent(useAppStore.getState(), WORKSPACE, 'source')
      }
    })
    await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce())
    const outcome = await opening.mock.results[0]!.value

    expect(outcome).toMatchObject({ status: 'opened' })
    if (outcome.status !== 'opened') {
      throw new Error('Expected opened link')
    }
    expect(useAppStore.getState().activeView).toBe('terminal')
    expect(useAppStore.getState().activeGroupIdByWorktree[WORKSPACE]).toBe(outcome.result.groupId)
    expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
  }
)

it('keeps the Activity view and current pane selected for background source-aware HTTP links', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      openLinksInApp: true,
      openLinksInAppInBackground: true
    }
  })
  const opening = vi.spyOn(workspaceBrowserTabOpen, 'openWorkspaceBrowserTabForLink')
  openHttpLink(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    sourceOwner: { kind: 'local' },
    linkContext: { linkIntent: captureLinkOpenIntent(useAppStore.getState(), WORKSPACE, 'source') }
  })
  await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce())
  expect(await opening.mock.results[0]!.value).toMatchObject({ status: 'opened' })
  expect(useAppStore.getState().activeView).toBe('activity')
  expect(useAppStore.getState().activeWorktreeId).toBe(WORKSPACE)
  expect(useAppStore.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})

it('keeps the main view and workspace selected when revealing a floating HTTP link', async () => {
  const floating = FLOATING_TERMINAL_WORKTREE_ID
  const state = useAppStore.getState()
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      openLinksInApp: true,
      floatingTerminalEnabled: true
    },
    floatingWorkspacePanelOpen: true,
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [floating]: state.groupsByWorktree[WORKSPACE]!.map((group) => ({
        ...group,
        worktreeId: floating
      }))
    },
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [floating]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        ...tab,
        worktreeId: floating
      }))
    },
    layoutByWorktree: { ...state.layoutByWorktree, [floating]: state.layoutByWorktree[WORKSPACE]! }
  })
  const opening = vi.spyOn(workspaceBrowserTabOpen, 'openWorkspaceBrowserTabForLink')
  openHttpLink(URL_TO_OPEN, {
    worktreeId: floating,
    sourceOwner: { kind: 'local' },
    linkContext: { linkIntent: captureLinkOpenIntent(useAppStore.getState(), floating, 'source') }
  })
  await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce())
  expect(await opening.mock.results[0]!.value).toMatchObject({ status: 'opened' })
  expect(useAppStore.getState().activeView).toBe('activity')
  expect(useAppStore.getState().activeWorktreeId).toBe(WORKSPACE)
  expect(['a', 'b', 'c']).not.toContain(useAppStore.getState().activeGroupIdByWorktree[floating])
})

it('reuses an exact page for an HTTP link without source context', async () => {
  const browser = useAppStore.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
    targetGroupId: 'b',
    browserRuntimeEnvironmentId: null,
    sessionProfileId: null,
    activate: false
  })
  const completed = observeBrowserLinkOpen()
  openHttpLink(URL_TO_OPEN, { worktreeId: WORKSPACE, sourceOwner: { kind: 'local' } })
  expect(await completed).toMatchObject({
    status: 'opened',
    result: { browserWorkspaceId: browser.id, browserPageId: browser.activePageId }
  })
  expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
})
