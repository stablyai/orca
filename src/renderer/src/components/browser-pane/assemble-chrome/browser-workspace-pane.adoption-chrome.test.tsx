// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { REMOTE_BROWSER_STREAM_LIVE } from '../stream-remote/remote-browser-stream-status'

// The two panes' runtime machinery is inert here. What this suite drives is the swap between them
// — the streamed pane a staged tab renders, and the client-hosted pane adoption replaces it with —
// and the address bar chrome that has to survive it.
const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  ensureRemotePage: vi.fn(async () => 'remote-page-a'),
  callRuntimeRpc: vi.fn(async () => ({ url: 'about:blank', title: 'New Tab' }))
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
    // Why non-null: the staged gate is the only thing that may stop a navigation here. A null
    // target would stop it first and let the gate be deleted with this suite still green.
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
  // Why a real focus target and not a spy: the pane focuses its guest on attach, and the whole
  // point of routing the resume through the focus grab is that this call must not win. A spy would
  // let the grab's latch be deleted with the focus assertions still green.
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

/** The handle hydration seeds for a client-hosted page restored from a previous run: a real host
 *  page id, but no placement until the relaunched host recovers the page. */
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

/**
 * Why the suite runs twice: every dev build renders under StrictMode, whose double-invoked effects
 * tear down and rebuild a mount that never went anywhere — which is exactly the shape the save and
 * resume here key off. A fix that only holds in production holds for nobody developing on it.
 */
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
      // Why the double claim throws here too: production's visible-attachment claim refuses a page
      // another attachment still holds, so a pane that re-attaches before detaching strands itself
      // on the unavailable notice. A mock that always succeeds cannot see that ordering break.
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
    installClientHostedPaneApi({ ui: { onFocusBrowserAddressBar: () => () => {} } })
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
    expect(screen.getByText('Example docs')).not.toBeNull()
  })

  // Why the draft alone is not enough here: while a suggestion is previewed the input holds that
  // suggestion's URL, and the query the user typed lives only beside it. Carrying the draft and
  // dropping the query leaves Escape with nothing to go back to.
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

  // Why: the resumed selection is restored against a bar the user is still typing into, and the
  // grab holds that bar for several frames after the swap. Re-applying the old caret on each of
  // them drags it back mid-word, and the next keystroke then replaces the selected text.
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

  // Why the caret is asserted after a theft and not just after the swap: the resume's own caret
  // restore is one-shot, spent on the commit that lands the draft. Everything after that rides on
  // the selection the grab carries, and without it a retry re-takes the bar with select-all — one
  // keystroke from wiping the draft it just rescued.
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

  // Why the closed direction needs its own test: the resuming focus opens the dropdown on its own,
  // so an open one survives whether or not the dropdown state is carried. Only a bar the user
  // dismissed with Escape — still focused, still holding their draft — proves it is.
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
    expect(screen.queryByText('Example docs')).toBeNull()
  })

  // Why: the swap tears the bar down and puts it back inside one React commit. A pane that goes
  // away and comes back later — a worktree switched away from and returned to — is a revisit, and
  // seizing focus there would be the bug this fix is meant to avoid rather than the fix itself.
  it('does not resume an edit into a pane that mounts in a later task', async () => {
    renderWorkspacePane()
    startEditing('example.int')

    cleanup()
    await act(async () => {})
    renderWorkspacePane()

    const remounted = addressBar()
    expect(remounted.value).toBe('about:blank')
    expect(document.activeElement).not.toBe(remounted)
  })

  it('leaves an idle address bar alone when the same swap happens', () => {
    renderWorkspacePane()
    const streamed = addressBar()
    expect(document.activeElement).not.toBe(streamed)

    act(() => adoptOntoClient())
    act(() => flushFrames())

    const adopted = addressBar()
    expect(adopted.value).toBe('about:blank')
    // Why: a user reading the page must not have focus yanked into chrome, nor a dropdown opened
    // over the page, by a handover they never asked for.
    expect(document.activeElement).not.toBe(adopted)
    expect(adopted.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Example docs')).toBeNull()
  })

  // The pane is no longer keyed on the generation, so a bump re-runs the attach rather than
  // remounting — but the edit has to survive either way.
  it('carries a live edit through a host restart that bumps the page generation', () => {
    renderWorkspacePane()
    act(() => adoptOntoClient())
    act(() => flushFrames())

    const before = startEditing('rebooting.internal')
    act(() => before.setSelectionRange(4, 4))

    act(() => adoptOntoClient(CLIENT_PLACEMENT.pageHostGeneration + 1))
    act(() => flushFrames())

    const after = addressBar()
    // Why identity and not just the draft: the edit-session registry rescues value, focus and
    // caret straight back through a remount, so those three assertions pass whether or not the
    // pane was rebuilt — they cannot see the thing this test is named for.
    expect(after).toBe(before)
    expect(after.value).toBe('rebooting.internal')
    expect(document.activeElement).toBe(after)
    expect([after.selectionStart, after.selectionEnd]).toEqual([4, 4])
  })

  // Why: a headless host keeps the page streamed, so the same snapshot must not disturb the pane
  // at all. This is the path the client-hosted fix must not regress.
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

    // Why: browser.tabShow against a page the host has not minted answers browser_tab_not_found,
    // which the streamed pane reads as "the page is gone" and closes the tab.
    expect(mocks.ensureRemotePage).not.toHaveBeenCalled()
    expect(webview.loadURL).not.toHaveBeenCalled()

    act(() => adoptOntoClient())
    act(() => flushFrames())

    expect(webview.loadURL).toHaveBeenCalledWith('https://example.internal/deferred')
  })

  // Why element identity and not the draft: every other assertion here is satisfied by a save and
  // resume across a remount. Only the same input node proves adoption never tore the chrome down —
  // a teardown is what replays the suggestion dropdown's open animation over the user's typing.
  it('adopts a client-hosted page without remounting the chrome', () => {
    stageClientHostedHandle()
    renderWorkspacePane()

    // The client-hosted pane mounts from the first frame, so there is no pane to swap at adoption.
    expect(screen.queryByTestId('streamed-viewport')).toBeNull()
    // The host has not minted this page yet: attaching would throw for an id the retained registry
    // has never seen and strand the pane on the unavailable notice.
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

  // Why this is asserted on its own: re-attaching in place is the entire replacement for the
  // pageHostGeneration the pane used to carry in its React key. Continuity tests stay green
  // whether or not the guest is ever re-attached — they pass hardest when nothing happens at all.
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

    // The host retired the old guest with the generation it belonged to; a pane still holding it
    // renders a dead webview that no longer answers.
    expect(attachedGenerations()).toContain(CLIENT_PLACEMENT.pageHostGeneration + 1)
    // Ordering is load-bearing, not incidental: the visible-attachment claim throws
    // visible_page_claimed if a second attach lands while the first still holds the page, and the
    // pane would strand itself on the unavailable notice.
    expect(stale.detach.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.attach.mock.invocationCallOrder.at(-1) as number
    )
    // The claim the attach double models: out of order it throws, and this is where that lands.
    expect(screen.queryByText('Client-hosted browser unavailable')).toBeNull()
    // ...without rebuilding the chrome around it, which is what the key change bought.
    expect(addressBar()).toBe(bar)
  })

  // Why the tour is gated on a real placement: recording the interaction is a one-way write that
  // burns the one-time tour, and a staged pane has no controls that work yet to point at.
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

  // Why this path still matters: the staged pane is chosen from a cached runtime status, and a
  // live one that disagrees sends the page to the server after all. That swap is the remount the
  // client-hosted path no longer takes, so the edit-session registry has to still carry the edit.
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

  // Why: a restored client-placed row has no placement until the relaunched host recovers it, and
  // the streamed pane would open a server screencast the host refuses for a client-placed page.
  it('mounts a restored client-hosted page on the client pane while the host recovers it', () => {
    restoreClientHostedHandle()
    renderWorkspacePane()

    expect(screen.queryByTestId('streamed-viewport')).toBeNull()
    expect(mocks.ensureRemotePage).not.toHaveBeenCalled()
    // The recovered page keeps its id but not its generation, so attaching now would strand the
    // pane on the unavailable notice.
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
