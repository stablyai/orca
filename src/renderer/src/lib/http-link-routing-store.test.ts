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
import { httpLinkActionDestinationsFor, openRoutedHttpLink } from './http-link-destinations'
import * as workspaceBrowserTabOpen from './workspace-browser-tab-open'
import type { DocPreviewExternalLink } from '../../../shared/doc-preview-scheme'
import { subscribeDocPreviewExternalLinkConfirmation } from '@/components/browser-pane/workspace-doc/doc-preview-external-link-confirmation'
import { canNativeChatOpenOwnedBrowser } from '@/components/native-chat/native-chat-http-link-source-owner'
import { canOfferHttpLinkGroupAction } from './http-link-in-group-availability'
import { runtimeStatuses } from '@/store/slices/browser-slice-test-harness'

const routeMocks = vi.hoisted(() => ({ remote: vi.fn(), error: vi.fn() }))
vi.mock('@/runtime/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: routeMocks.remote
}))
vi.mock('sonner', () => ({ toast: { error: routeMocks.error } }))

const OTHER_WORKSPACE = 'repo1::/other'

vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))

beforeEach(() => {
  useAppStore.setState({ createBrowserTab: useAppStore.getInitialState().createBrowserTab })
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

it.each([
  'old-runtime',
  'ssh-global',
  'ssh-target',
  'client-fail',
  'remote-false',
  'remote-reject'
] as const)(
  'preserves legacy URL/provider outcomes through the registered preview route: %s',
  async (mode) => {
    const ssh = mode.startsWith('ssh')
    const remote = mode.startsWith('remote')
    const failed = remote || mode === 'client-fail'
    const hostId = ssh ? 'ssh:source' : 'runtime:source'
    for (const path of ['legacy', 'preview'] as const) {
      useAppStore.setState({ createBrowserTab: useAppStore.getInitialState().createBrowserTab })
      seedBrowserLinkTestStore(useAppStore)
      useAppStore.setState((state) => ({
        activeWorkspaceExecutionHostId: hostId,
        worktreesByRepo: {
          repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1', path: '/repo', hostId })]
        },
        unifiedTabsByWorktree: {
          [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
            ...tab,
            executionHostId: hostId
          }))
        },
        runtimeStatusByEnvironmentId: remote
          ? new Map([['source', runtimeStatuses(['browser.screencast.v1']).get('env-1')!]])
          : new Map(),
        settings: {
          ...getDefaultSettings('/home/test'),
          openLinksInApp: true,
          browserSshWorkspaceRoutingEnabled: mode !== 'ssh-global',
          browserSshWorkspaceRoutingDisabledTargetIds: mode === 'ssh-target' ? ['source'] : []
        }
      }))
      const owner = ssh
        ? { kind: 'ssh' as const, connectionId: 'source' }
        : { kind: 'runtime' as const, runtimeEnvironmentId: 'source' }
      const sourceState = useAppStore.getState()
      if (!remote) {
        const state = sourceState
        const available = canNativeChatOpenOwnedBrowser(state, WORKSPACE, owner)
        expect(available).toBe(false)
        expect(httpLinkActionDestinationsFor(state.settings, owner, available)).toEqual({
          primary: 'system'
        })
        expect(
          canOfferHttpLinkGroupAction(state, {
            workspaceId: WORKSPACE,
            sourceTabId: 'source',
            sourceOwner: owner,
            url: URL_TO_OPEN
          })
        ).toBe(false)
      }
      routeMocks.remote.mockReset()
      routeMocks.error.mockClear()
      if (mode === 'remote-reject') {
        routeMocks.remote.mockRejectedValue(new Error('private provider error'))
      } else {
        routeMocks.remote.mockResolvedValue(false)
      }
      const preview = sourceState.createBrowserTab(WORKSPACE, 'https://example.com/source', {
        activate: false,
        executionHostId: hostId,
        browserRuntimeEnvironmentId: null,
        targetGroupId: 'a'
      })
      const create = vi.spyOn(useAppStore.getState(), 'createBrowserTab')
      if (mode === 'client-fail') {
        create.mockImplementationOnce(() => {
          throw new Error('Cannot create browser tab')
        })
      }
      if (path === 'legacy') {
        const opening = sourceState.openBrowserProfileTabInActiveWorkspace(URL_TO_OPEN, null)
        if (mode === 'client-fail') {
          await expect(opening).rejects.toThrow('Cannot create browser tab')
        } else {
          expect(await opening).toBe(!remote)
        }
      } else {
        const onExternalLink = vi.fn(
          (_callback: (event: DocPreviewExternalLink) => void) => () => {}
        )
        vi.stubGlobal('window', { api: { ...window.api, docPreview: { onExternalLink } } })
        const confirm = vi.fn(async () => true)
        const dispose = subscribeDocPreviewExternalLinkConfirmation(confirm, {
          grantId: 'grant',
          worktreeId: WORKSPACE,
          browserWorkspaceId: preview.id,
          owner: ssh
            ? { kind: 'ssh', connectionId: 'source' }
            : {
                kind: 'runtime',
                environmentId: 'source',
                worktreeSelector: `id:${WORKSPACE}`,
                worktreeRoot: '/repo'
              }
        })
        const completed = observeBrowserLinkOpen()
        onExternalLink.mock.calls[0]?.[0]({ url: URL_TO_OPEN, grantId: 'grant' })
        expect(await completed).toMatchObject({ status: failed ? 'failed' : 'opened' })
        expect(
          vi.mocked(workspaceBrowserTabOpen.openWorkspaceBrowserTabForLink).mock.calls[0]?.[0]
            .linkContext.linkIntent
        ).not.toBeNull()
        if (failed) {
          await vi.waitFor(() =>
            expect(routeMocks.error).toHaveBeenCalledExactlyOnceWith('Unable to open URL.')
          )
        } else {
          expect(routeMocks.error).not.toHaveBeenCalled()
        }
        expect(confirm).toHaveBeenCalledOnce()
        dispose()
      }
      if (remote) {
        expect(routeMocks.remote).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            worktreeId: WORKSPACE,
            environmentId: 'source',
            url: URL_TO_OPEN
          })
        )
        expect(create).not.toHaveBeenCalled()
      } else if (!failed) {
        expect(create).toHaveBeenCalledExactlyOnceWith(
          WORKSPACE,
          URL_TO_OPEN,
          expect.objectContaining({ browserRuntimeEnvironmentId: null })
        )
        const state = useAppStore.getState()
        expect(state.browserTabsByWorktree[WORKSPACE]).toHaveLength(2)
        expect(
          Object.values(state.browserPagesByWorkspace)
            .flat()
            .filter((page) => page.url === URL_TO_OPEN)
        ).toEqual([expect.objectContaining({ url: URL_TO_OPEN })])
        expect(
          state.unifiedTabsByWorktree[WORKSPACE]!.find(
            (tab) => tab.contentType === 'browser' && tab.entityId !== preview.id
          )?.executionHostId
        ).toBe(hostId)
        expect(routeMocks.remote).not.toHaveBeenCalled()
      }
      vi.restoreAllMocks()
    }
  }
)
