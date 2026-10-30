// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { REMOTE_BROWSER_STREAM_LIVE } from '../stream-remote/remote-browser-stream-status'

// Drive pane adoption with inert runtime machinery while keeping the address-bar lifecycle real.
const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  ensureRemotePage: vi.fn(async () => 'remote-page-a'),
  callRuntimeRpc: vi.fn(async () => ({ url: 'about:blank', title: 'New Tab' }))
}))

vi.mock('./browser-page-pane', () => ({
  BrowserPagePane: () => {
    throw new Error('Adoption chrome tests must not render the local browser pane')
  }
}))

vi.mock('../workspace-doc/workspace-doc-page-pane', () => ({
  WorkspaceDocPagePane: () => {
    throw new Error('Adoption chrome tests must not render a workspace document pane')
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), message: vi.fn() }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  runtimeEnvironmentSupportsCapability: vi.fn(async () => false)
}))

vi.mock('@/lib/workspace-browser-tab-open', () => ({
  openWorkspaceBrowserTab: vi.fn(async () => {})
}))

vi.mock('../annotate/markup-clipboard-delivery', () => ({
  deliverMarkupToClipboard: vi.fn(async () => {})
}))

vi.mock('../annotate/useMarkupMode', () => ({
  useMarkupMode: () => ({
    isActive: false,
    baseImage: null,
    state: 'idle',
    start: vi.fn(),
    cancel: vi.fn(),
    complete: vi.fn()
  })
}))

vi.mock('../stream-remote/use-remote-browser-page-lifecycle', () => ({
  useRemoteBrowserPageLifecycle: () => ({
    lifecycle: {
      session: {
        ensureRemotePage: mocks.ensureRemotePage,
        scheduleTabInfoRefresh: vi.fn()
      },
      tokens: {}
    },
    streamStatus: REMOTE_BROWSER_STREAM_LIVE,
    frameUrl: null,
    frameMetadata: null,
    runtimeWorktree: 'worktree-a',
    // Keep the runtime target valid so only the staged gate can prevent navigation.
    runtimeTarget: () => ({ kind: 'environment', environmentId: ENVIRONMENT_ID }),
    createRemoteOperationToken: () => ({ environmentId: ENVIRONMENT_ID, generation: 1 }),
    isCurrentRemoteOperationToken: () => true,
    clearStreamFrame: vi.fn(),
    closeMissingRemotePage: vi.fn(),
    mountedRef: { current: true },
    isActiveRef: { current: true },
    streamBridgeRef: { current: null },
    streamFrameUrlRef: { current: null },
    pendingFrameDecodeRef: { current: 0 },
    remoteViewportSizeRef: { current: null },
    remoteCssViewportSizeRef: { current: null },
    remoteViewportTimerRef: { current: null },
    setFrameUrl: vi.fn(),
    setFrameMetadata: vi.fn()
  })
}))

vi.mock('../stream-remote/use-remote-browser-page-stream', () => ({
  useRemoteBrowserPageStream: () => ({ reconnectRemoteStream: vi.fn() })
}))

vi.mock('../stream-remote/use-remote-browser-page-input', () => ({
  useRemoteBrowserPageInputQueue: () => ({
    enqueueRemoteInput: vi.fn(),
    clearPendingRemoteWheel: vi.fn(),
    resetRemoteInputQueue: vi.fn(),
    pendingRemoteWheelRef: { current: null },
    remoteWheelFrameRef: { current: null },
    remoteWheelInFlightRef: { current: false }
  }),
  useRemoteBrowserPageInput: () => ({
    getRemoteImagePoint: () => null,
    handleRemotePointerDown: vi.fn(),
    handleRemotePointerUp: vi.fn(),
    handleRemoteScreenshotKeyDown: vi.fn()
  })
}))

vi.mock('../stream-remote/use-remote-browser-page-wheel', () => ({
  useRemoteBrowserPageWheel: vi.fn()
}))

vi.mock('../stream-remote/remote-browser-page-context-menu', () => ({
  RemoteBrowserPageContextMenu: () => null,
  useRemoteBrowserPageContextMenu: () => ({
    contextMenu: null,
    setContextMenu: vi.fn(),
    handleRemoteContextMenu: vi.fn()
  })
}))

vi.mock('../stream-remote/remote-browser-page-viewport', () => ({
  RemoteBrowserPageViewport: ({
    remoteViewportRef
  }: {
    remoteViewportRef: React.RefObject<HTMLDivElement | null>
  }) => <div ref={remoteViewportRef} tabIndex={-1} data-testid="streamed-viewport" />
}))

vi.mock('../browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))

import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installClientHostedPaneApi } from '../client-hosted-browser-pane-test-rig'
import { clearBrowserAddressBarEditSession } from './browser-address-bar-edit-session'
import { clearBrowserPageDeferredNavigation } from '../navigate/browser-page-deferred-navigation'
import BrowserPane from './browser-workspace-pane'

const ENVIRONMENT_ID = 'environment-a'
const WORKSPACE_ID = 'workspace-a'
const PAGE_ID = 'page-a'

const CLIENT_PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

let frameCallbacks: FrameRequestCallback[] = []

function flushFrames(cycles = 8): void {
  for (let index = 0; index < cycles; index += 1) {
    const pending = frameCallbacks
    frameCallbacks = []
    for (const callback of pending) {
      callback(0)
    }
  }
}

function createWebview(): Electron.WebviewTag & { loadURL: ReturnType<typeof vi.fn> } {
  const webview = document.createElement('webview') as Electron.WebviewTag & {
    loadURL: ReturnType<typeof vi.fn>
  }
  // Use real guest focus: a spy cannot expose whether the resumed address-bar latch defeats it.
  webview.tabIndex = -1
  Object.assign(webview, {
    getURL: vi.fn(() => 'about:blank'),
    getTitle: vi.fn(() => 'New Tab'),
    isLoading: vi.fn(() => false),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    getWebContentsId: vi.fn(() => 42),
    getZoomLevel: vi.fn(() => 0),
    setZoomLevel: vi.fn(),
    focus: vi.fn(() => HTMLElement.prototype.focus.call(webview)),
    blur: vi.fn(() => HTMLElement.prototype.blur.call(webview)),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    loadURL: vi.fn(async () => {})
  })
  return webview
}

function browserPage(): BrowserPage {
  return {
    id: PAGE_ID,
    workspaceId: WORKSPACE_ID,
    worktreeId: 'worktree-a',
    url: 'about:blank',
    title: 'New Tab',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1,
    browserRuntimeEnvironmentId: ENVIRONMENT_ID
  }
}

function browserWorkspace(): BrowserWorkspace {
  return {
    id: WORKSPACE_ID,
    worktreeId: 'worktree-a',
    activePageId: PAGE_ID,
    pageIds: [PAGE_ID],
    url: 'about:blank',
    title: 'New Tab',
    loading: false,
    faviconUrl: null
  } as BrowserWorkspace
}

/** The optimistic handle a staged tab carries: a page id the host has not published yet. */
function stageHandle(): void {
  useAppStore.setState({
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: { environmentId: ENVIRONMENT_ID, remotePageId: 'remote-page-a', staged: true }
    }
  })
}

/** The optimistic handle for a page this client already expects to host itself. */
function stageClientHostedHandle(): void {
  useAppStore.setState({
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: {
        environmentId: ENVIRONMENT_ID,
        remotePageId: 'remote-page-a',
        staged: true,
        stagedClientHosted: true
      }
    }
  })
}

/** Restored client-hosted pages have a real host ID but no placement until host recovery. */
function restoreClientHostedHandle(): void {
  useAppStore.setState({
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: {
        environmentId: ENVIRONMENT_ID,
        remotePageId: 'remote-page-a',
        restoredFromSession: true,
        restoredClientHosted: true
      }
    }
  })
}

/** The host snapshot arriving: the staged flag drops and the page lands on this desktop. */
function adoptOntoClient(pageHostGeneration = CLIENT_PLACEMENT.pageHostGeneration): void {
  useAppStore.setState({
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: {
        environmentId: ENVIRONMENT_ID,
        remotePageId: 'remote-page-a',
        placement: { ...CLIENT_PLACEMENT, pageHostGeneration }
      }
    }
  })
}

/** The same snapshot for a headless host: the page stays streamed, so the pane never swaps. */
function adoptOntoServer(): void {
  useAppStore.setState({
    remoteBrowserPageHandlesByPageId: {
      [PAGE_ID]: { environmentId: ENVIRONMENT_ID, remotePageId: 'remote-page-a' }
    }
  })
}

/** Repeat under StrictMode because effect replay resembles the save/resume teardown without a real pane departure. */
let strictMode = false

function renderWorkspacePane(): void {
  const pane = (
    <TooltipProvider>
      <BrowserPane browserTab={browserWorkspace()} isActive chromeShortcutScope="focused" />
    </TooltipProvider>
  )
  render(strictMode ? <StrictMode>{pane}</StrictMode> : pane)
  act(() => flushFrames())
}

function addressBar(): HTMLInputElement {
  return document.querySelector('[data-orca-browser-address-bar]') as HTMLInputElement
}

/** The page generations the pane has attached a guest for, in call order. */
function attachedGenerations(): number[] {
  return mocks.attach.mock.calls.map(
    (call) => (call[0] as { pageHostGeneration: number }).pageHostGeneration
  )
}

/** Type into the bar the way a user does: focus first (which opens the dropdown), then keys. */
function startEditing(text: string): HTMLInputElement {
  const input = addressBar()
  act(() => input.focus())
  act(() => {
    fireEvent.change(input, { target: { value: text } })
  })
  return input
}

describe.each([
  { tree: 'in a plain tree', strict: false },
  { tree: 'under StrictMode', strict: true }
])('BrowserPane adoption keeps live address-bar chrome ($tree)', ({ strict }) => {
  let webview: ReturnType<typeof createWebview>
  let liveAttachment: { detached: boolean } | null = null

  beforeEach(() => {
    strictMode = strict
    frameCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    webview = createWebview()
    liveAttachment = null
    mocks.attach.mockReset().mockImplementation((_args: unknown, viewport: HTMLElement) => {
      // Model the real visible-attachment claim: a second attach before detach must fail so ordering errors stay observable.
      if (liveAttachment?.detached === false) {
        throw new Error('browser_client_page_renderer_visible_page_claimed')
      }
      viewport.appendChild(webview)
      const attachment = {
        webview,
        detached: false,
        detach: vi.fn(() => {
          attachment.detached = true
          webview.remove()
        }),
        nextMetadataRevision: vi.fn(() => 1)
      }
      liveAttachment = attachment
      return attachment
    })
    mocks.ensureRemotePage.mockClear()
    mocks.callRuntimeRpc.mockClear()
    installClientHostedPaneApi({
      ui: { onFocusBrowserAddressBar: () => () => {}, onShowBrowserHistory: () => () => {} }
    })
    useAppStore.setState({
      browserPagesByWorkspace: { [WORKSPACE_ID]: [browserPage()] },
      browserUrlHistory: [
        {
          url: 'https://example.internal/docs',
          normalizedUrl: 'example.internal/docs',
          title: 'Example docs',
          lastVisitedAt: Date.now(),
          visitCount: 3
        }
      ],
      browserCertificateFailuresByPageId: {},
      pendingAddressBarFocusByPageId: {},
      pendingAddressBarFocusByTabId: {}
    })
    stageHandle()
  })

  afterEach(() => {
    cleanup()
    clearBrowserAddressBarEditSession(PAGE_ID)
    clearBrowserPageDeferredNavigation(PAGE_ID)
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('carries the draft, caret and open suggestions through the staged-to-client swap', () => {
    renderWorkspacePane()
    expect(screen.getByTestId('streamed-viewport')).not.toBeNull()

    const staged = startEditing('example.int')
    act(() => staged.setSelectionRange(3, 7))
    expect(staged.getAttribute('aria-expanded')).toBe('true')

    act(() => adoptOntoClient())
    act(() => flushFrames())

    // The pane really did swap: the streamed viewport is gone and the guest is attached.
    expect(screen.queryByTestId('streamed-viewport')).toBeNull()
    expect(mocks.attach).toHaveBeenCalled()

    const adopted = addressBar()
    expect(adopted.value).toBe('example.int')
    expect(document.activeElement).toBe(adopted)
    expect([adopted.selectionStart, adopted.selectionEnd]).toEqual([3, 7])
    expect(adopted.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('option', { name: /Example docs/ })).not.toBeNull()
  })

  // Previewed URLs live in the input; carry the separate typed query too or Escape cannot restore it.
  it('carries the typed query behind a previewed suggestion through the swap', () => {
    renderWorkspacePane()
    const staged = startEditing('example')
    act(() => {
      fireEvent.keyDown(staged, { key: 'ArrowDown' })
    })
    expect(staged.value).toBe('https://example.internal/docs')

    act(() => adoptOntoClient())
    act(() => flushFrames())

    const adopted = addressBar()
    expect(adopted.value).toBe('https://example.internal/docs')
    act(() => {
      fireEvent.keyDown(adopted, { key: 'Escape' })
    })
    expect(adopted.value).toBe('example')
  })

  // Apply the saved caret once; retrying it after typing would move it backward or overwrite new text.
  it('leaves the caret where the user puts it while the grab is still retrying', () => {
    renderWorkspacePane()
    const staged = startEditing('example.int')
    act(() => staged.setSelectionRange(3, 7))

    act(() => adoptOntoClient())

    const adopted = addressBar()
    act(() => {
      fireEvent.change(adopted, { target: { value: 'example.internal/docs' } })
    })
    act(() => adopted.setSelectionRange(12, 12))
    // The frames the grab would have spent re-taking the bar all land after the user typed.
    act(() => flushFrames())

    expect(adopted.value).toBe('example.internal/docs')
    expect([adopted.selectionStart, adopted.selectionEnd]).toEqual([12, 12])
  })

  // Steal focus after resume to exercise the grab’s caret restore; otherwise select-all retries can escape detection.
  it('restores the caret, not a select-all, when the guest takes the bar back mid-grab', () => {
    renderWorkspacePane()
    const staged = startEditing('example.int')
    act(() => staged.setSelectionRange(3, 7))

    act(() => adoptOntoClient())
    act(() => flushFrames(1))

    const adopted = addressBar()
    expect(document.activeElement).toBe(adopted)
    act(() => webview.focus())
    expect(document.activeElement).toBe(webview)

    act(() => flushFrames())

    expect(document.activeElement).toBe(adopted)
    expect(adopted.value).toBe('example.int')
    expect([adopted.selectionStart, adopted.selectionEnd]).toEqual([3, 7])
  })

  // An open list survives focus naturally; only a dismissed list proves dropdown state crosses the swap.
  it('keeps a dismissed suggestion list dismissed through the swap', () => {
    renderWorkspacePane()
    const staged = startEditing('example.int')
    act(() => {
      fireEvent.keyDown(staged, { key: 'Escape' })
    })
    expect(staged.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(staged)

    act(() => adoptOntoClient())
    act(() => flushFrames())

    const adopted = addressBar()
    expect(adopted.value).toBe('example.int')
    expect(document.activeElement).toBe(adopted)
    expect(adopted.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('option', { name: /Example docs/ })).toBeNull()
  })

  // Only same-commit swaps may reclaim focus; later worktree revisits must not resume old edits.
  it('does not resume an edit into a pane that mounts in a later task', async () => {
    renderWorkspacePane()
    startEditing('example.int')

    cleanup()
    await act(async () => {})
    renderWorkspacePane()

    const remounted = addressBar()
    expect(remounted.value).toBe('')
    expect(document.activeElement).not.toBe(remounted)
  })

  it('leaves an idle address bar alone when the same swap happens', () => {
    renderWorkspacePane()
    const streamed = addressBar()
    expect(document.activeElement).not.toBe(streamed)

    act(() => adoptOntoClient())
    act(() => flushFrames())

    const adopted = addressBar()
    expect(adopted.value).toBe('')
    // Adoption without an active edit must not seize chrome focus or open suggestions.
    expect(document.activeElement).not.toBe(adopted)
    expect(adopted.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('option', { name: /Example docs/ })).toBeNull()
  })

  // Generation changes reattach in place; edits must survive without remounting.
  it('carries a live edit through a host restart that bumps the page generation', () => {
    renderWorkspacePane()
    act(() => adoptOntoClient())
    act(() => flushFrames())

    const before = startEditing('rebooting.internal')
    act(() => before.setSelectionRange(4, 4))

    act(() => adoptOntoClient(CLIENT_PLACEMENT.pageHostGeneration + 1))
    act(() => flushFrames())

    const after = addressBar()
    // The registry can rescue drafts across remounts; node identity is needed to prove the chrome was never rebuilt.
    expect(after).toBe(before)
    expect(after.value).toBe('rebooting.internal')
    expect(document.activeElement).toBe(after)
    expect([after.selectionStart, after.selectionEnd]).toEqual([4, 4])
  })

  // Headless adoption stays streamed and must preserve the same live edit.
  it('keeps a live edit when a headless host adopts the page in place', () => {
    renderWorkspacePane()
    const streamed = startEditing('headless.internal')
    act(() => streamed.setSelectionRange(8, 8))

    act(() => adoptOntoServer())
    act(() => flushFrames())

    const after = addressBar()
    expect(screen.getByTestId('streamed-viewport')).not.toBeNull()
    expect(after).toBe(streamed)
    expect(after.value).toBe('headless.internal')
    expect(document.activeElement).toBe(after)
    expect([after.selectionStart, after.selectionEnd]).toEqual([8, 8])
  })

  it('holds a URL submitted against the staged page and loads it once the guest attaches', () => {
    renderWorkspacePane()
    const staged = startEditing('https://example.internal/deferred')
    act(() => {
      fireEvent.submit(staged.closest('form') ?? staged)
    })

    // tabShow before host minting returns browser_tab_not_found, which would close the staged tab.
    expect(mocks.ensureRemotePage).not.toHaveBeenCalled()
    expect(webview.loadURL).not.toHaveBeenCalled()

    act(() => adoptOntoClient())
    act(() => flushFrames())

    expect(webview.loadURL).toHaveBeenCalledWith('https://example.internal/deferred')
  })

  // Only input identity exposes chrome remounts; save/resume can otherwise hide the repeated dropdown animation.
  it('adopts a client-hosted page without remounting the chrome', () => {
    stageClientHostedHandle()
    renderWorkspacePane()

    // The client-hosted pane mounts from the first frame, so there is no pane to swap at adoption.
    expect(screen.queryByTestId('streamed-viewport')).toBeNull()
    // Do not attach before the host publishes the page; the retained registry would reject the unknown ID.
    expect(mocks.attach).not.toHaveBeenCalled()
    expect(screen.queryByText('Client-hosted browser unavailable')).toBeNull()

    const staged = startEditing('example.int')
    act(() => staged.setSelectionRange(3, 7))
    expect(staged.getAttribute('aria-expanded')).toBe('true')

    act(() => adoptOntoClient())
    act(() => flushFrames())

    expect(addressBar()).toBe(staged)
    expect(staged.getAttribute('aria-expanded')).toBe('true')
    expect(staged.value).toBe('example.int')
    expect(document.activeElement).toBe(staged)
    expect([staged.selectionStart, staged.selectionEnd]).toEqual([3, 7])
    expect(mocks.attach).toHaveBeenCalled()
  })

  // Continuity alone passes if nothing happens; verify generation changes really reattach the guest.
  it('re-attaches the guest when a host restart bumps the page generation', () => {
    stageClientHostedHandle()
    renderWorkspacePane()
    act(() => adoptOntoClient())
    act(() => flushFrames())

    const bar = addressBar()
    const stale = mocks.attach.mock.results.at(-1)?.value as { detach: ReturnType<typeof vi.fn> }
    expect(attachedGenerations()).toContain(CLIENT_PLACEMENT.pageHostGeneration)
    expect(attachedGenerations()).not.toContain(CLIENT_PLACEMENT.pageHostGeneration + 1)

    act(() => adoptOntoClient(CLIENT_PLACEMENT.pageHostGeneration + 1))
    act(() => flushFrames())

    // The host retires the previous generation’s guest; retaining it would leave an inert tag.
    expect(attachedGenerations()).toContain(CLIENT_PLACEMENT.pageHostGeneration + 1)
    // Detach before attach or the visible-page claim strands the pane on the unavailable notice.
    expect(stale.detach.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.attach.mock.invocationCallOrder.at(-1) as number
    )
    expect(screen.queryByText('Client-hosted browser unavailable')).toBeNull()
    expect(addressBar()).toBe(bar)
  })

  // Do not consume a one-time tour before placement makes its controls usable.
  it('does not burn the intro tour on a pane that is still connecting', () => {
    const recordFeatureInteraction = vi.fn(async () => {})
    useAppStore.setState({
      persistedUIReady: true,
      contextualToursSeenIds: ['client-hosted-browser'],
      recordFeatureInteraction
    } as unknown as Parameters<typeof useAppStore.setState>[0])
    stageClientHostedHandle()
    renderWorkspacePane()

    expect(recordFeatureInteraction).not.toHaveBeenCalled()

    act(() => adoptOntoClient())
    act(() => flushFrames())

    expect(recordFeatureInteraction).toHaveBeenCalledWith('client-hosted-browser')
  })

  // Live host status can override cached client placement and swap to streaming; retain edit-session recovery for this path.
  it('carries a live edit when a staged client-hosted page is adopted onto the server', () => {
    stageClientHostedHandle()
    renderWorkspacePane()
    expect(screen.queryByTestId('streamed-viewport')).toBeNull()

    const staged = startEditing('fallback.internal')
    act(() => staged.setSelectionRange(4, 4))

    act(() => adoptOntoServer())
    act(() => flushFrames())

    // The pane really did fall back to the streamed one.
    expect(screen.getByTestId('streamed-viewport')).not.toBeNull()
    const adopted = addressBar()
    expect(adopted.value).toBe('fallback.internal')
    expect(document.activeElement).toBe(adopted)
    expect([adopted.selectionStart, adopted.selectionEnd]).toEqual([4, 4])
  })

  it('holds a URL submitted against a staged client-hosted page until its guest attaches', () => {
    stageClientHostedHandle()
    renderWorkspacePane()
    const staged = startEditing('https://example.internal/client-deferred')
    act(() => {
      fireEvent.submit(staged.closest('form') ?? staged)
    })

    expect(webview.loadURL).not.toHaveBeenCalled()

    act(() => adoptOntoClient())
    act(() => flushFrames())

    expect(webview.loadURL).toHaveBeenCalledWith('https://example.internal/client-deferred')
  })

  // Restored client-placed pages must await recovery locally; hosts reject server screencasts for them.
  it('mounts a restored client-hosted page on the client pane while the host recovers it', () => {
    restoreClientHostedHandle()
    renderWorkspacePane()

    expect(screen.queryByTestId('streamed-viewport')).toBeNull()
    expect(mocks.ensureRemotePage).not.toHaveBeenCalled()
    // Recovery retains the ID but replaces its generation; attaching early would strand the pane.
    expect(mocks.attach).not.toHaveBeenCalled()
    expect(screen.queryByText('Client-hosted browser unavailable')).toBeNull()

    act(() => adoptOntoClient())
    act(() => flushFrames())

    expect(mocks.attach).toHaveBeenCalled()
  })

  it('replays a URL held against the staged page when a headless host adopts it', async () => {
    renderWorkspacePane()
    const staged = startEditing('https://example.internal/headless')
    act(() => {
      fireEvent.submit(staged.closest('form') ?? staged)
    })
    expect(mocks.ensureRemotePage).not.toHaveBeenCalled()

    await act(async () => {
      adoptOntoServer()
    })

    expect(mocks.ensureRemotePage).toHaveBeenCalledTimes(1)
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENVIRONMENT_ID }),
      'browser.goto',
      expect.objectContaining({ url: 'https://example.internal/headless' }),
      expect.anything()
    )
  })
})
