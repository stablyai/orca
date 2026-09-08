// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'
import type { MarkupBaseImage } from './annotate/markup-base-image'

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  capture: vi.fn(),
  compose: vi.fn(),
  clipboard: vi.fn(),
  error: vi.fn()
}))
vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))
// Only image/native boundaries are mocked; the button, controller and overlay are real.
vi.mock('./annotate/markup-base-image', () => ({ captureMarkupBaseImage: mocks.capture }))
vi.mock('./annotate/markup-screenshot-compose', () => ({ composeMarkupDataUrl: mocks.compose }))
vi.mock('./annotate/markup-canvas-render', () => ({
  renderCommittedLayer: vi.fn(),
  blitMarkupScene: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: vi.fn() } }))

type PaneProps = ComponentProps<typeof ClientHostedBrowserPagePane>
const image: MarkupBaseImage = {
  dataUrl: 'data:image/png;base64,YmFzZQ==',
  width: 800,
  height: 600
}
const placement = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

beforeEach(() => {
  installClientHostedPaneApi({ ui: { writeClipboardImage: mocks.clipboard } })
  useAppStore.setState({ browserCertificateFailuresByPageId: {} })
  window.localStorage.setItem('orca.browser.markup-draw-hint-seen', 'true')
  mocks.capture.mockResolvedValue(image)
  mocks.compose.mockResolvedValue({ dataUrl: 'data:image/png;base64,Y29tcG9zaXRl' })
  mocks.clipboard.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function renderPane(overrides: Partial<PaneProps> = {}, attaches = true) {
  const webview = document.createElement('webview') as Electron.WebviewTag
  Object.assign(webview, {
    getURL: () => 'https://example.internal/app',
    getTitle: () => 'App',
    isLoading: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    getWebContentsId: () => 42,
    getZoomLevel: () => 0,
    focus: vi.fn(),
    blur: vi.fn(),
    getBoundingClientRect: () => ({ width: 800, height: 600 })
  })
  mocks.attach.mockReturnValue(
    attaches ? { webview, detach: vi.fn(), nextMetadataRevision: () => 1 } : null
  )
  let props: PaneProps = {
    browserTab: {
      id: 'page-a',
      workspaceId: 'workspace-a',
      worktreeId: 'folder-a',
      url: 'https://example.internal/app',
      title: 'App',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    },
    workspaceId: 'workspace-a',
    runtimeEnvironmentId: 'environment-a',
    worktreeId: 'folder-a',
    placement,
    isActive: true,
    chromeShortcutScope: 'focused',
    onUpdatePageState: vi.fn(),
    onSetUrl: vi.fn(),
    ...overrides
  }
  const element = () => (
    <TooltipProvider>
      <ClientHostedBrowserPagePane {...props} />
    </TooltipProvider>
  )
  const view = render(element())
  return {
    webview,
    unmount: view.unmount,
    update: (updates: Partial<PaneProps>) => {
      props = { ...props, ...updates }
      view.rerender(element())
    }
  }
}

function drawButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Draw on screenshot' })
}
function overlay(): HTMLElement | null {
  return document.querySelector('[data-orca-markup-overlay]')
}
async function startDrawing() {
  fireEvent.click(drawButton())
  await waitFor(() => expect(overlay()).not.toBeNull())
}

describe('client-hosted screenshot markup', () => {
  it('captures the retained guest before hiding it, then copies through the shared overlay', async () => {
    let resolveCapture!: (value: MarkupBaseImage) => void
    mocks.capture.mockReturnValue(
      new Promise<MarkupBaseImage>((resolve) => {
        resolveCapture = resolve
      })
    )
    const { webview } = renderPane()
    fireEvent.click(drawButton())
    expect(mocks.capture).toHaveBeenCalledWith({ kind: 'webview', webview })
    expect(webview.style.display).toBe('flex')
    expect(drawButton().getAttribute('aria-pressed')).toBe('true')
    expect(overlay()).toBeNull()

    await act(async () => resolveCapture(image))
    expect(webview.style.display).toBe('none')
    const backdrop = overlay()!.querySelector('img')!
    expect(backdrop.src).toBe(image.dataUrl)
    fireEvent.load(backdrop)
    fireEvent.click(screen.getByRole('button', { name: 'Copy Markup' }))
    await waitFor(() =>
      expect(mocks.clipboard).toHaveBeenCalledWith('data:image/png;base64,Y29tcG9zaXRl')
    )
    expect(mocks.compose).toHaveBeenCalledWith(
      expect.objectContaining({
        image: backdrop,
        displayCssWidth: 800,
        displayCssHeight: 600,
        shapes: []
      })
    )
    await waitFor(() => expect(overlay()).toBeNull())
    expect(webview.style.display).toBe('flex')
    expect(drawButton().getAttribute('aria-pressed')).toBe('false')
  })

  it.each(['Cancel', 'Escape', 'toggle'])('restores the guest after %s', async (action) => {
    const { webview } = renderPane()
    await startDrawing()
    if (action === 'Cancel') {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    } else if (action === 'Escape') {
      fireEvent.keyDown(window, { key: 'Escape' })
    } else {
      fireEvent.click(drawButton())
    }
    expect(overlay()).toBeNull()
    expect(webview.style.display).toBe('flex')
    expect(mocks.clipboard).not.toHaveBeenCalled()
  })

  it('returns to idle after a capture failure', async () => {
    mocks.capture.mockRejectedValue(new Error('guest capture failed'))
    const { webview } = renderPane()
    fireEvent.click(drawButton())
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('Could not capture the page to draw on.')
    )
    expect(drawButton().getAttribute('aria-pressed')).toBe('false')
    expect(webview.style.display).toBe('flex')
    expect(overlay()).toBeNull()
  })

  it.each(['pending', 'unavailable', 'inactive', 'failed'])(
    'disables Draw for a %s pane',
    (state) => {
      const pane = renderPane(
        {
          ...(state === 'pending' ? { placement: null } : {}),
          ...(state === 'inactive' ? { isActive: false } : {})
        },
        state !== 'unavailable'
      )
      if (state === 'failed') {
        fireEvent(pane.webview, new Event('destroyed'))
      }
      expect(drawButton().disabled).toBe(true)
      fireEvent.click(drawButton())
      expect(mocks.capture).not.toHaveBeenCalled()
    }
  )

  it.each(['cancel', 'deactivate', 'replace', 'loss', 'unmount'])(
    'invalidates an in-flight capture on %s',
    async (action) => {
      let resolveCapture!: (value: MarkupBaseImage) => void
      mocks.capture.mockReturnValue(
        new Promise<MarkupBaseImage>((resolve) => {
          resolveCapture = resolve
        })
      )
      const pane = renderPane()
      fireEvent.click(drawButton())
      if (action === 'cancel') {
        fireEvent.click(drawButton())
      }
      if (action === 'deactivate') {
        pane.update({ isActive: false })
      }
      if (action === 'replace') {
        pane.update({ placement: { ...placement, pageHostGeneration: 8 } })
      }
      if (action === 'loss') {
        fireEvent(pane.webview, new Event('destroyed'))
      }
      if (action === 'unmount') {
        pane.unmount()
      }
      await act(async () => resolveCapture(image))
      if (action === 'deactivate') {
        pane.update({ isActive: true })
      }
      expect(overlay()).toBeNull()
      expect(pane.webview.style.display).toBe('flex')
      expect(mocks.clipboard).not.toHaveBeenCalled()
    }
  )

  it('restores the retained guest on unmount while drawing', async () => {
    const pane = renderPane()
    await startDrawing()
    expect(pane.webview.style.display).toBe('none')
    pane.unmount()
    expect(pane.webview.style.display).toBe('flex')
  })
})
