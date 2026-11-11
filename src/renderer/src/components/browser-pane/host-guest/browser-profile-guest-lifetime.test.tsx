// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserPagePaneProps } from '../describe-page/browser-page-types'
import type { createTestStore as CreateTestStore } from '@/store/testing/app-store-test-fixture'
import type { AppState } from '@/store/types'

type ProfileMocks = {
  native: Map<number, Electron.WebContents>
  store: ReturnType<typeof CreateTestStore> | null
  agent: boolean
  renders: Map<string, number>
  prepareRoute: ReturnType<typeof vi.fn>
  profileRequest:
    | ((args: {
        requestId: string
        browserPageId: string
        profileId: string
        sessionPartition: string
      }) => void)
    | null
}
const mocks = vi.hoisted<ProfileMocks>(() => ({
  native: new Map(),
  store: null,
  agent: false,
  renders: new Map(),
  prepareRoute: vi.fn(),
  profileRequest: null
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: (id: number) => mocks.native.get(id) ?? null }
}))
vi.mock(
  '../../../../../main/browser/guest-lifecycle/popups/presentation/popup-origin-bar-window',
  () => ({ openPopupWithOriginBar: vi.fn() })
)
vi.mock('../../../../../main/runtime/rpc/rpc-active-caller', () => ({
  getActiveRpcCaller: () => ({ kind: mocks.agent ? 'local-cli' : 'desktop' })
}))
vi.mock('../../../../../main/window/renderer-publication-throttle', () => ({
  rendererPublicationThrottle: { acquire: () => vi.fn() }
}))
vi.mock(
  '../../../../../main/browser/guest-lifecycle/manager/registration/browser-guest-discard-protection',
  async (original) => ({
    ...(await original<object>()),
    readBrowserGuestDiscardProtection: () => ({ protection: 'discardable' })
  })
)
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => mocks.store!(selector), {
    getState: () => mocks.store!.getState()
  })
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
vi.mock('@/lib/workspace/ownership/worktree-host-connection-phase', () => ({
  useWorktreeHostConnection: () => ({
    phase: 'connected',
    targetId: 'target-a',
    connectedEpoch: 'target-a:1'
  })
}))
vi.mock('../annotate/guest-annotation-viewport-bridge', () => ({
  syncGuestAnnotationViewportBridge: () => {}
}))
vi.mock('@/components/native-chat/media/visuals/NativeChatVisualGuestThemePublisher', () => ({
  publishNativeChatVisualGuestTheme: () => {}
}))
vi.mock('../assemble-chrome/browser-page-pane', () => ({
  BrowserPagePane: (props: BrowserPagePaneProps) => <LifecyclePage {...props} />
}))
vi.mock('../stream-remote/remote-browser-page-pane', () => ({
  RemoteBrowserPagePane: () => <span>Remote page</span>
}))
vi.mock('../ClientHostedBrowserPagePane', () => ({
  ClientHostedBrowserPagePane: () => <span>Client page</span>
}))

import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import { registerBrowserRequestIpcBridge } from '@/hooks/ipc-events/browser-request-ipc-bridge'
import BrowserPane from '../assemble-chrome/browser-workspace-pane'
import { useBrowserPageWebviewLifecycle } from './use-browser-page-webview-lifecycle'
import { useBrowserPageWebviewPartition } from './use-browser-page-webview-partition'
import { ensureBrowserPageViewport } from './browser-page-viewport'
import { installBrowserGuestPageRetention } from './browser-guest-page-retention'
import { verifiedPartitionByRoute } from '../ssh-workspace-browser-verified-routes'
import {
  installProfileNativeFixture,
  ProfileTestGuest
} from './browser-profile-native.test-fixture'
import { discardPersistentWebview, webviewRegistry } from './webview-registry'
import {
  admitBrowserPageMount,
  isBrowserPageMountAdmitted,
  releaseBrowserPageMount
} from './browser-page-mount-admission'
import {
  browserMemoryGeneration,
  claimBrowserMemoryPage,
  reserveBrowserPageDiscard,
  retainBrowserMemoryPageForAgent,
  waitForBrowserPageReady
} from '../../../../../main/browser/guest-lifecycle/browser-page-memory'
import {
  collectBrowserWebviewIds,
  destroyRemovedBrowserWebview,
  destroyWebviewsRemovedFromStore
} from '@/store/slices/browser/cleanup/browser-webview-cleanup'

const WT = 'repo1::/path/wt1'
const ref = <T,>(current: T) => ({ current })
const noFocus = () => false
function LifecyclePage(props: BrowserPagePaneProps) {
  const { browserTab: page } = props
  mocks.renders.set(page.id, (mocks.renders.get(page.id) ?? 0) + 1)
  const refs = useRef({
    addressBarInputRef: ref<HTMLInputElement | null>(null),
    addressBarValueRef: ref(page.url),
    browserTabUrlRef: ref(page.url),
    keepAddressBarFocusRef: ref(false),
    handleInternalFileDragOverRef: ref(() => {}),
    handleInternalFileDropRef: ref(() => {}),
    dismissAddressBarSuggestionsRef: ref(null),
    lastKnownWebviewUrlRef: ref<string | null>(null),
    recoveryNavigationValidationRef: ref(null),
    activeLoadFailureRef: ref(null),
    retryGuestRecoveryRef: ref(() => {}),
    webviewRef: ref<Electron.WebviewTag | null>(null),
    onUpdatePageStateRef: ref(props.onUpdatePageState),
    onSetUrlRef: ref(props.onSetUrl)
  }).current
  const partition = useBrowserPageWebviewPartition(props)
  const viewport = ensureBrowserPageViewport(page.id, props.workspaceId)
  useBrowserPageWebviewLifecycle({
    ...refs,
    browserTabId: page.id,
    browserTabUrl: page.url,
    browserTabLoading: page.loading,
    browserTabLoadError: page.loadError,
    workspaceId: props.workspaceId,
    worktreeId: props.worktreeId,
    sessionProfileId: props.sessionProfileId,
    webviewPartition: partition,
    isActive: props.isActive,
    isPaintable:
      props.isActive || props.isAutomationVisible || props.isMobileDriven || props.isRemotelyViewed,
    isMountAdmitted: props.isMountAdmitted ?? false,
    slotViewport: viewport?.container ?? null,
    viewportPresetId: null,
    onUpdatePageState: props.onUpdatePageState,
    onSetUrl: props.onSetUrl,
    setAddressBarValue: () => {},
    cancelPendingBrowserCapture: () => {},
    setBrowserOverlayViewport: () => {},
    setFindOpen: () => {},
    focusAddressBarNow: noFocus,
    focusWebviewNow: noFocus,
    pendingAnnotationPayload: null,
    inputLocked: false,
    faviconUrl: null
  })
  return <span>{page.title}</span>
}
function Workspace({ id, active = true }: { id: string; active?: boolean }) {
  const tab = mocks.store!((s) => s.browserTabsByWorktree[WT]?.find((entry) => entry.id === id))
  return tab ? <BrowserPane browserTab={tab} isActive={active} /> : null
}
let fixture: ReturnType<typeof installProfileNativeFixture>
let main: TabsDrawnFromMain
let unsubscribers: (() => void)[]
async function settle() {
  await act(async () => {
    await main.settle()
    await fixture.settled()
  })
}
async function workspace(size = 3) {
  const tab = mocks
    .store!.getState()
    .createBrowserTab(WT, 'https://example.test', { activate: true })
  await settle()
  for (let index = 1; index < size; index++) {
    mocks.store!.getState().createBrowserPage(tab.id, 'https://example.test', { activate: false })
  }
  await settle()
  fixture.mountViewport(tab.id)
  return { id: tab.id, pages: mocks.store!.getState().browserPagesByWorkspace[tab.id] }
}
beforeEach(async () => {
  mocks.agent = false
  mocks.prepareRoute.mockReset()
  verifiedPartitionByRoute.clear()
  mocks.renders.clear()
  mocks.store = createTestStore()
  fixture = installProfileNativeFixture(mocks.native)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: { ...fixture.api, prepareSshWorkspacePartition: mocks.prepareRoute },
      ui: {
        onSystemResumed: () => () => {},
        onRequestRemoteCliBrowserScope: () => () => {},
        onRequestTabCreate: () => () => {},
        onRequestTabClose: () => () => {},
        onRequestTabSetProfile: (listener: typeof mocks.profileRequest) => {
          mocks.profileRequest = listener
          return () => {}
        },
        replyTabSetProfile: vi.fn()
      },
      settings: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      runtimeEnvironments: { call: vi.fn(async () => ({})) }
    }
  })
  unsubscribers = []
  registerBrowserRequestIpcBridge(unsubscribers)
  seedStore(mocks.store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT,
    activeTabType: 'terminal',
    browserSessionProfilesByHostId: {
      local: [
        {
          id: 'default',
          scope: 'default',
          partition: 'persist:default',
          label: 'Default',
          source: null
        },
        { id: 'work', scope: 'isolated', partition: 'persist:work', label: 'Work', source: null }
      ]
    }
  })
  main = await drawTabsFromMain(mocks.store)
  let membership = collectBrowserWebviewIds(
    mocks.store.getState().browserTabsByWorktree,
    mocks.store.getState().browserPagesByWorkspace
  )
  unsubscribers.push(
    mocks.store.subscribe((state) => {
      membership = destroyWebviewsRemovedFromStore(
        membership,
        state.browserTabsByWorktree,
        state.browserPagesByWorkspace
      )
    })
  )
})
afterEach(async () => {
  cleanup()
  unsubscribers.forEach((unsubscribe) => unsubscribe())
  await fixture.close()
  main.close()
})

it('keeps cold profile siblings absent, preserves live agent ownership and wakes a disposed cold shell on demand', async () => {
  const { id, pages } = await workspace()
  const view = render(<Workspace id={id} />)
  await settle()
  const [a, b, h] = pages
  const coldGuest = fixture.guests.get(b.id)!
  // All requested background pages load once before their admission ends.
  expect(fixture.creations).toEqual([a.id, b.id, h.id])
  mocks.agent = true
  claimBrowserMemoryPage(h.id)()
  mocks.agent = false
  const generation = browserMemoryGeneration(h.id)
  const coldWebview = webviewRegistry.get(b.id)!
  expect(discardPersistentWebview(b.id, coldWebview, coldGuest.id)).toBe(true)
  releaseBrowserPageMount(b.id)
  await settle()
  const before = fixture.creations.length
  const oldHeld = fixture.guests.get(h.id)!
  const oldHeldMetadata = fixture.metadata(oldHeld)!
  fixture.pauseLoads()
  act(() =>
    mocks.profileRequest!({
      requestId: 'profile',
      browserPageId: a.id,
      profileId: 'work',
      sessionPartition: 'persist:work'
    })
  )
  await act(async () => {
    await main.settle()
  })
  const replacementHeld = fixture.guests.get(h.id)!
  expect(replacementHeld).not.toBe(oldHeld)
  expect(isBrowserPageMountAdmitted(h.id)).toBe(true)
  expect(
    await fixture.api.unregisterGuest({
      browserPageId: h.id,
      webContentsId: oldHeld.id,
      replacement: true
    })
  ).toBe(false)
  fixture.deliverMetadata(oldHeldMetadata)
  expect(fixture.manager.getGuestWebContentsId(h.id)).toBe(replacementHeld.id)
  expect(isBrowserPageMountAdmitted(h.id)).toBe(true)
  await act(async () => {
    fixture.finish(a.id)
    fixture.finish(h.id)
    await Promise.resolve()
  })
  await settle()
  expect(fixture.creations.slice(before).sort()).toEqual([a.id, h.id].sort())
  expect(webviewRegistry.has(b.id)).toBe(false)
  expect(browserMemoryGeneration(h.id)).toBe(generation)
  expect(reserveBrowserPageDiscard(h.id, fixture.guests.get(h.id)!.asWebContents())).toBe(false)
  expect(fixture.unregistrations.every((args) => args.replacement === true)).toBe(true)
  view.rerender(<Workspace id={id} active={false} />)
  await settle()
  expect(webviewRegistry.has(b.id)).toBe(false)
  act(() => mocks.store!.getState().setActiveBrowserPage(id, b.id))
  view.rerender(<Workspace id={id} />)
  await act(async () => {
    await main.settle()
  })
  await act(async () => {
    fixture.finish(b.id)
    await Promise.resolve()
  })
  await settle()
  expect(fixture.creations.slice(before).filter((pageId) => pageId === b.id)).toHaveLength(1)
  expect(webviewRegistry.get(b.id)?.getAttribute('partition')).toBe('persist:work')
  expect(fixture.guests.get(b.id)!.navigationHistory.restore).not.toHaveBeenCalled()
})

it('keeps a cold page and a held live page through route errors, retry and a new verified profile', async () => {
  const { id, pages } = await workspace()
  const [a, b, h] = pages
  const view = render(<Workspace id={id} />)
  await settle()
  const cold = fixture.guests.get(b.id)!
  expect(discardPersistentWebview(b.id, webviewRegistry.get(b.id)!, cold.id)).toBe(true)
  releaseBrowserPageMount(b.id)
  await settle()
  mocks.agent = true
  claimBrowserMemoryPage(h.id)()
  mocks.agent = false
  const generation = browserMemoryGeneration(h.id)
  const coldGeneration = browserMemoryGeneration(b.id)
  const before = fixture.creations.length
  let failRoute!: (error: Error) => void
  mocks.prepareRoute.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      failRoute = reject
    })
  )
  act(() =>
    mocks.store!.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, executionHostId: 'ssh:target-a' }))
    }))
  )
  await settle()
  expect(fixture.creations).toHaveLength(before)
  expect(webviewRegistry.size).toBe(0)
  expect(isBrowserPageMountAdmitted(a.id)).toBe(true)
  expect(isBrowserPageMountAdmitted(h.id)).toBe(true)
  expect(isBrowserPageMountAdmitted(b.id)).toBe(false)
  await act(async () => {
    failRoute(new Error('browser_local_route_ssh_unavailable'))
    await Promise.resolve()
  })
  expect(view.getByText('SSH connection unavailable')).toBeTruthy()
  expect(browserMemoryGeneration(h.id)).toBe(generation)
  expect(browserMemoryGeneration(b.id)).toBe(coldGeneration)
  mocks.prepareRoute.mockResolvedValueOnce({ partition: 'persist:routed-default' })
  act(() => view.getByRole('button', { name: 'Retry' }).click())
  await settle()
  expect(fixture.creations.slice(before).sort()).toEqual([a.id, h.id].sort())
  expect(reserveBrowserPageDiscard(h.id, fixture.guests.get(h.id)!.asWebContents())).toBe(false)
  mocks.prepareRoute.mockResolvedValueOnce({ partition: 'persist:routed-work' })
  act(() =>
    mocks.profileRequest!({
      requestId: 'routed-profile',
      browserPageId: a.id,
      profileId: 'work',
      sessionPartition: 'persist:work'
    })
  )
  await settle()
  expect(webviewRegistry.get(a.id)?.getAttribute('partition')).toBe('persist:routed-work')
  expect(webviewRegistry.has(b.id)).toBe(false)
  expect(browserMemoryGeneration(h.id)).toBe(generation)
  expect(fixture.unregistrations.every((args) => args.replacement === true)).toBe(true)
  const returning = fixture.preparations.length
  mocks.prepareRoute.mockResolvedValueOnce({ partition: 'persist:routed-default' })
  act(() =>
    mocks.profileRequest!({
      requestId: 'return-default',
      browserPageId: a.id,
      profileId: 'default',
      sessionPartition: 'persist:default'
    })
  )
  await settle()
  expect(
    fixture.preparations
      .slice(returning)
      .map(({ browserPageId, partition }) => ({ browserPageId, partition }))
      .sort((x, y) => x.browserPageId.localeCompare(y.browserPageId))
  ).toEqual(
    [a.id, h.id]
      .sort()
      .map((browserPageId) => ({ browserPageId, partition: 'persist:routed-default' }))
  )
  expect(webviewRegistry.has(b.id)).toBe(false)
  mocks.prepareRoute.mockResolvedValueOnce({ partition: 'persist:routed-work' })
  act(() =>
    mocks.profileRequest!({
      requestId: 'return-work',
      browserPageId: a.id,
      profileId: 'work',
      sessionPartition: 'persist:work'
    })
  )
  await settle()
  act(() => mocks.store!.getState().setActiveBrowserPage(id, b.id))
  await settle()
  expect(webviewRegistry.get(b.id)?.getAttribute('partition')).toBe('persist:routed-work')
  expect(fixture.guests.get(b.id)!.navigationHistory.restore).not.toHaveBeenCalled()
})

it('preserves cold URL and title across a failed route and same-partition recovery', async () => {
  mocks.prepareRoute.mockResolvedValue({ partition: 'persist:routed-default' })
  act(() =>
    mocks.store!.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, executionHostId: 'ssh:target-a' }))
    }))
  )
  const { id, pages } = await workspace(2)
  const view = render(<Workspace id={id} />)
  await settle()
  const [a, b] = pages
  const guest = fixture.guests.get(b.id)!
  guest.url = 'https://example.test/retained'
  expect(discardPersistentWebview(b.id, webviewRegistry.get(b.id)!, guest.id)).toBe(true)
  releaseBrowserPageMount(b.id)
  mocks.prepareRoute.mockRejectedValueOnce(new Error('browser_local_route_ssh_unavailable'))
  act(() =>
    mocks.store!.setState((state) => ({
      settings: {
        ...createGlobalSettingsFixture(state.settings ?? {}),
        browserSshWorkspaceRoutingProbeSkippedTargetIds: ['target-a']
      }
    }))
  )
  await settle()
  expect(view.getByText('SSH connection unavailable')).toBeTruthy()
  expect(webviewRegistry.has(b.id)).toBe(false)
  act(() => view.getByRole('button', { name: 'Retry' }).click())
  await settle()
  act(() => mocks.store!.getState().setActiveBrowserPage(id, b.id))
  await settle()
  expect(fixture.guests.get(b.id)!.navigationHistory.restore).toHaveBeenCalledWith({
    entries: [{ url: 'https://example.test/retained', title: 'Retained title' }],
    index: 0
  })
  expect(fixture.guests.get(b.id)!.getURL()).toBe('https://example.test/retained')
  expect(webviewRegistry.has(a.id)).toBe(true)
})

it('closes a cold and an accepted pending lifecycle through actual cleanup', async () => {
  const { id, pages } = await workspace(2)
  render(<Workspace id={id} />)
  await settle()
  const b = pages[1]
  const old = fixture.guests.get(b.id)!
  expect(discardPersistentWebview(b.id, webviewRegistry.get(b.id)!, old.id)).toBe(true)
  releaseBrowserPageMount(b.id)
  await settle()
  const previous = browserMemoryGeneration(b.id)
  mocks.prepareRoute.mockRejectedValueOnce(new Error('browser_local_route_ssh_unavailable'))
  act(() =>
    mocks.store!.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, executionHostId: 'ssh:target-a' }))
    }))
  )
  await settle()
  expect(webviewRegistry.size).toBe(0)
  mocks.agent = true
  retainBrowserMemoryPageForAgent('accepted-pending', new ProfileTestGuest(99).asWebContents())
  mocks.agent = false
  destroyRemovedBrowserWebview('accepted-pending')
  act(() => mocks.store!.getState().closeBrowserPage(b.id))
  await settle()
  expect(browserMemoryGeneration(b.id)).not.toBe(previous)
  expect(fixture.unregistrations).toContainEqual({ browserPageId: b.id })
  expect(fixture.unregistrations).toContainEqual({ browserPageId: 'accepted-pending' })
  const fresh = mocks
    .store!.getState()
    .createBrowserTab(WT, 'https://example.test', { browserPageId: 'accepted-pending' })
  await settle()
  mocks.store!.setState((state) => ({
    repos: state.repos.map((repo) => ({ ...repo, executionHostId: 'local' }))
  }))
  fixture.mountViewport(fresh.id)
  render(<Workspace id={fresh.id} />)
  await settle()
  expect(
    reserveBrowserPageDiscard(
      'accepted-pending',
      fixture.guests.get('accepted-pending')!.asWebContents()
    )
  ).toBe(true)
})

it('preserves unresolved hidden loads and wakes a retired admission while another remains pending', async () => {
  const { id, pages } = await workspace(3)
  fixture.pauseLoads()
  const view = render(<Workspace id={id} />)
  await act(async () => {
    await main.settle()
  })
  const [, a, b] = pages
  const aGuest = fixture.guests.get(a.id)!
  const bGuest = fixture.guests.get(b.id)!
  const initialCount = fixture.creations.length
  view.rerender(<Workspace id={id} active={false} />)
  await act(async () => {
    await main.settle()
  })
  expect(fixture.guests.get(a.id)).toBe(aGuest)
  expect(fixture.guests.get(b.id)).toBe(bGuest)
  expect(fixture.creations).toHaveLength(initialCount)
  // Native completion precedes its queued metadata publication to the renderer.
  fixture.pauseMetadata()
  aGuest.finish()
  await waitForBrowserPageReady(a.id, aGuest.asWebContents())
  await act(async () => {
    const stop = installBrowserGuestPageRetention({
      limit: 0,
      isBlocked: (pageId) => pageId !== a.id,
      discard: (pageId, webview, guestId) => {
        const discarded = discardPersistentWebview(pageId, webview, guestId)
        if (discarded) {
          releaseBrowserPageMount(pageId)
        }
        return discarded
      }
    })
    await Promise.resolve()
    stop()
  })
  expect(webviewRegistry.has(a.id)).toBe(false)
  expect(isBrowserPageMountAdmitted(a.id)).toBe(false)
  expect(isBrowserPageMountAdmitted(b.id)).toBe(true)
  expect(fixture.creations).toHaveLength(initialCount)
  fixture.flushMetadata()
  act(() => admitBrowserPageMount(a.id))
  await act(async () => {
    await main.settle()
  })
  expect(fixture.creations.slice(initialCount)).toEqual([a.id])
  await act(async () => {
    for (const page of pages) {
      fixture.finish(page.id)
    }
    await Promise.resolve()
  })
  await settle()
})

it.each([4, 40])(
  'changes the owning tab at N=%i without cold loads or unrelated renders',
  async (size) => {
    const target = await workspace(size)
    const other = await workspace(size)
    render(
      <>
        <Workspace id={target.id} />
        <Workspace id={other.id} active={false} />
      </>
    )
    await settle()
    await act(async () => {
      for (const page of target.pages.slice(1, -1)) {
        const guest = fixture.guests.get(page.id)!
        expect(discardPersistentWebview(page.id, webviewRegistry.get(page.id)!, guest.id)).toBe(
          true
        )
        releaseBrowserPageMount(page.id)
      }
      await Promise.resolve()
    })
    await settle()
    const before = fixture.creations.length
    mocks.renders.clear()
    const lookup = vi.spyOn(webviewRegistry, 'get')
    act(() =>
      mocks.profileRequest!({
        requestId: 'scale',
        browserPageId: target.pages[0].id,
        profileId: 'work',
        sessionPartition: 'persist:work'
      })
    )
    await settle()
    expect(fixture.creations.slice(before).sort()).toEqual(
      [target.pages[0].id, target.pages.at(-1)!.id].sort()
    )
    for (const page of target.pages.slice(1, -1)) {
      expect(lookup.mock.calls.filter(([pageId]) => pageId === page.id)).toHaveLength(1)
    }
    for (const page of other.pages) {
      expect(mocks.renders.get(page.id) ?? 0).toBe(0)
      expect(lookup.mock.calls.filter(([pageId]) => pageId === page.id)).toHaveLength(0)
    }
    lookup.mockRestore()
    mocks.renders.clear()
    act(() =>
      mocks.store!.setState({
        browserAnnotationMarkerIdsByPageId: { [other.pages[0].id]: ['marker'] }
      })
    )
    await settle()
    expect([...mocks.renders.keys()]).toEqual([other.pages[0].id])
  }
)

it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
  'reconciles actual current profile when an older frame wait or ended stream releases a callback',
  async () => {
    const { layoutApplyTestTransport: transport } =
      await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
    const { noteLayoutFramePosition, endLayoutFramePositions } =
      await import('@/runtime/workspace-layout/frames/layout-frame-position')
    const { id, pages } = await workspace(1)
    render(<Workspace id={id} />)
    await settle()
    mocks.store!.setState((state) => ({
      browserSessionProfilesByHostId: {
        local: [
          ...state.browserSessionProfilesByHostId.local!,
          {
            id: 'other',
            scope: 'isolated',
            partition: 'persist:other',
            label: 'Other',
            source: null
          }
        ]
      }
    }))
    const original = fixture.guests.get(pages[0].id)
    transport.answerWith('pending')
    act(() =>
      mocks.profileRequest!({
        requestId: 'old',
        browserPageId: pages[0].id,
        profileId: 'work',
        sessionPartition: 'persist:work'
      })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(fixture.guests.get(pages[0].id)).toBe(original)
    transport.answerWith('accept')
    transport.answerPending({ ok: true, result: {}, frameSeq: 2000 })
    await settle()
    transport.answerWith('apply')
    act(() =>
      mocks.profileRequest!({
        requestId: 'new',
        browserPageId: pages[0].id,
        profileId: 'other',
        sessionPartition: 'persist:other'
      })
    )
    await settle()
    const current = fixture.guests.get(pages[0].id)
    const before = fixture.creations.length
    act(() => noteLayoutFramePosition(2000))
    await settle()
    expect(fixture.guests.get(pages[0].id)).toBe(current)
    expect(webviewRegistry.get(pages[0].id)?.getAttribute('partition')).toBe('persist:other')
    expect(fixture.creations).toHaveLength(before)
    transport.answerWith('pending')
    act(() =>
      mocks.profileRequest!({
        requestId: 'ended',
        browserPageId: pages[0].id,
        profileId: 'work',
        sessionPartition: 'persist:work'
      })
    )
    await act(async () => {
      await Promise.resolve()
    })
    transport.answerWith('accept')
    transport.answerPending({ ok: true, result: {}, frameSeq: 3000 })
    await settle()
    act(() => endLayoutFramePositions())
    await settle()
    expect(fixture.guests.get(pages[0].id)).toBe(current)
    expect(fixture.creations).toHaveLength(before)
    expect(isBrowserPageMountAdmitted(pages[0].id)).toBe(false)
  }
)

it('separates runtime presentation from local page ownership and actual removal', async () => {
  const { id, pages } = await workspace(3)
  const view = render(<Workspace id={id} />)
  await settle()
  const [local, inherited, explicit] = pages
  mocks.agent = true
  claimBrowserMemoryPage(inherited.id)()
  mocks.agent = false
  const generation = browserMemoryGeneration(inherited.id)
  const count = fixture.creations.length
  act(() =>
    mocks.store!.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, executionHostId: 'runtime:env-a' })),
      browserPagesByWorkspace: {
        ...state.browserPagesByWorkspace,
        [id]: state.browserPagesByWorkspace[id].map((page) => {
          if (page.id === inherited.id) {
            const { browserRuntimeEnvironmentId: _owner, ...rest } = page
            return rest
          }
          return { ...page, browserRuntimeEnvironmentId: page.id === local.id ? null : 'env-a' }
        })
      }
    }))
  )
  await settle()
  expect(webviewRegistry.has(local.id)).toBe(true)
  act(() => mocks.store!.getState().setActiveBrowserPage(id, inherited.id))
  await settle()
  expect(view.getByText('Remote page')).toBeTruthy()
  expect(webviewRegistry.has(local.id)).toBe(true)
  expect(webviewRegistry.has(inherited.id)).toBe(false)
  expect(webviewRegistry.has(explicit.id)).toBe(false)
  expect(browserMemoryGeneration(inherited.id)).toBe(generation)
  expect(fixture.unregistrations.every((args) => args.replacement === true)).toBe(true)
  act(() =>
    mocks.store!.setState((state) => ({
      remoteBrowserPageHandlesByPageId: {
        ...state.remoteBrowserPageHandlesByPageId,
        [inherited.id]: {
          environmentId: 'env-a',
          remotePageId: 'remote-b',
          staged: true,
          stagedClientHosted: true
        }
      }
    }))
  )
  await settle()
  expect(view.getByText('Client page')).toBeTruthy()
  expect(fixture.creations).toHaveLength(count)
  act(() =>
    mocks.store!.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, executionHostId: 'local' })),
      browserPagesByWorkspace: {
        ...state.browserPagesByWorkspace,
        [id]: state.browserPagesByWorkspace[id].map((page) => ({
          ...page,
          browserRuntimeEnvironmentId: null
        }))
      }
    }))
  )
  await settle()
  expect(browserMemoryGeneration(inherited.id)).toBe(generation)
  expect(
    reserveBrowserPageDiscard(inherited.id, fixture.guests.get(inherited.id)!.asWebContents())
  ).toBe(false)
  act(() => mocks.store!.getState().closeBrowserPage(inherited.id))
  await settle()
  expect(browserMemoryGeneration(inherited.id)).toBeUndefined()
})
