// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'

const mocks = vi.hoisted(() => ({ attach: vi.fn(), createBrowserTab: vi.fn(async () => true) }))

vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: mocks.createBrowserTab
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), message: vi.fn() }
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { acquireWebviewsDragPassthrough } from './host-guest/webview-registry'
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

function page(): BrowserPage {
  return {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'about:blank',
    title: 'New Tab',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function createGuest(): { webview: Electron.WebviewTag; focus: ReturnType<typeof vi.fn> } {
  const webview = document.createElement('webview') as Electron.WebviewTag
  const focus = vi.fn()
  Object.assign(webview, {
    getURL: vi.fn(() => 'about:blank'),
    getTitle: vi.fn(() => 'New Tab'),
    isLoading: vi.fn(() => false),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    focus,
    blur: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    loadURL: vi.fn(async () => {})
  })
  let revision = 0
  mocks.attach.mockReturnValue({
    webview,
    detach: vi.fn(),
    nextMetadataRevision: vi.fn(() => ++revision)
  })
  return { webview, focus }
}

/** Set per describe half: the renderer itself runs under StrictMode, so the focus latch has to
 *  survive an effect being destroyed and recreated on a pane that never went anywhere. */
let wrap: (tree: ReactNode) => React.JSX.Element = (tree) => <>{tree}</>

function paneElement(isActive: boolean): React.JSX.Element {
  return wrap(
    <TooltipProvider>
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive={isActive}
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    </TooltipProvider>
  )
}

const openReleases: (() => void)[] = []

/** A tab drag in flight, taken through the entry point the drag gesture lifecycle calls. */
function startDrag(): () => void {
  let release!: () => void
  act(() => {
    release = acquireWebviewsDragPassthrough()
  })
  openReleases.push(release)
  return () => act(() => release())
}

describe.each([
  ['plain', (tree: ReactNode) => <>{tree}</>],
  ['StrictMode', (tree: ReactNode) => <StrictMode>{tree}</StrictMode>]
])('client-hosted guest focus during a tab drag (%s)', (_half, wrapHalf) => {
  beforeEach(() => {
    wrap = wrapHalf
    mocks.attach.mockReset()
    installClientHostedPaneApi()
  })

  afterEach(() => {
    for (const release of openReleases.splice(0)) {
      release()
    }
    cleanup()
  })

  it('focuses the guest when the tab activates outside a drag', () => {
    const { focus } = createGuest()
    const view = render(paneElement(false))

    view.rerender(paneElement(true))

    expect(focus).toHaveBeenCalledTimes(1)
  })

  // Why this matters: a drag preview-activates whatever tab it hovers, and focusing the guest
  // hands focus to another WebContents. The embedder blur that follows is exactly what the drag's
  // missed-end fallback treats as an aborted gesture, so the drag would die on its own preview.
  it('leaves the guest unfocused while a drag holds guests click-through', () => {
    const { focus } = createGuest()
    const view = render(paneElement(false))
    startDrag()

    view.rerender(paneElement(true))

    expect(focus).not.toHaveBeenCalled()
  })

  it('focuses the guest once the drag that preview-activated it ends', () => {
    const { focus } = createGuest()
    const view = render(paneElement(false))
    const endDrag = startDrag()
    view.rerender(paneElement(true))

    endDrag()

    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('leaves a tab the drag did not land on unfocused after the drag ends', () => {
    const { focus } = createGuest()
    const view = render(paneElement(false))
    const endDrag = startDrag()
    view.rerender(paneElement(true))
    view.rerender(paneElement(false))

    endDrag()

    expect(focus).not.toHaveBeenCalled()
  })

  // Why this matters: the gate makes the focus effect reactive, so a drag anywhere in the window —
  // a terminal pane reorder, a drag of some other tab — re-runs it on a tab that was already active.
  // Focusing the guest there takes focus off an address bar the user is typing in, and the URL-follow
  // guard only holds the draft while the bar still owns focus.
  it('leaves an already-active guest alone when an unrelated drag ends', () => {
    const { focus } = createGuest()
    render(paneElement(true))
    focus.mockClear()

    const endDrag = startDrag()
    endDrag()

    expect(focus).not.toHaveBeenCalled()
  })

  it('focuses the guest again when the tab is reactivated after such a drag', () => {
    const { focus } = createGuest()
    const view = render(paneElement(true))
    const endDrag = startDrag()
    endDrag()
    focus.mockClear()

    view.rerender(paneElement(false))
    view.rerender(paneElement(true))

    expect(focus).toHaveBeenCalledTimes(1)
  })
})
