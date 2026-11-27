// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

// The renderer's own webview readback: a second capture owner beside main's per-guest lane.
const webviewReadback = vi.hoisted(() => vi.fn())
vi.mock('./capture/markup-base-image', () => ({
  captureMarkupBaseImage: webviewReadback,
  flattenCapturedPage: async (capture: unknown) => capture
}))
vi.mock('./use-browser-guest-annotate-tools', () => ({
  useBrowserGuestAnnotateTools: () => ({
    viewportBridge: { handleGuestDocumentEvent: () => {} },
    grab: { state: 'idle' },
    elementTools: null,
    notes: null
  })
}))
vi.mock('./browser-guest-annotate-overlays', () => ({ BrowserGuestAnnotateOverlays: () => null }))
vi.mock('./browser-guest-grab-banner', () => ({ BrowserGuestGrabBanner: () => null }))
vi.mock('./MarkupOverlay', () => ({ MarkupOverlay: () => null }))
vi.mock('sonner', () => ({ toast: Object.assign(() => 'toast', { error: () => 'error' }) }))

const { useClientHostedBrowserAnnotate } = await import('./use-client-hosted-browser-annotate')
const { DRAW_CAPTURE_DEADLINE_MS } = await import('./palette/use-grab-clean-capture')

type HookArgs = Parameters<typeof useClientHostedBrowserAnnotate>
const capturedPage = { dataUrl: 'data:image/png;base64,AA', width: 800, height: 600 }
const mainCleanCapture = vi.fn(
  async (_args: { browserPageId: string; requestId: string }) => capturedPage
)
const mainCancel = vi.fn(async (_args: { browserPageId: string; requestId?: string }) => true)

beforeEach(() => {
  webviewReadback.mockReset()
  mainCleanCapture.mockClear()
  mainCancel.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        captureCleanPage: mainCleanCapture,
        cancelGrab: mainCancel,
        setGrabMode: async () => ({ ok: true, clean: true })
      }
    }
  })
})

function renderClientHostedAnnotate() {
  const webview = {
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    style: {},
    capturePage: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only id/url of the tab and the placement generations.
  const pane = {
    browserTab: { id: 'page-1', url: 'https://example.test/' },
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    runtimeEnvironmentId: 'env-1',
    placement: { browserHostClientId: 'client', browserHostGeneration: 1, pageHostGeneration: 1 },
    isActive: true,
    chromeShortcutScope: 'browser'
  } as unknown as HookArgs[0]
  const initialization = { unavailable: false, showFailureOverlay: false, showNewTab: false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Draw reads only the webview's bounds, style and capturePage.
  const webviewRef = { current: webview as unknown as Electron.WebviewTag }
  const viewportRef = { current: document.createElement('div') }
  const hook = renderHook(() =>
    useClientHostedBrowserAnnotate(pane, initialization, webviewRef, viewportRef, null)
  )
  return { hook, webview }
}

it("client-hosted Draw captures through main's per-guest capture owner, never the renderer's webview", async () => {
  const { hook, webview } = renderClientHostedAnnotate()
  act(() => {
    hook.result.current.tools.markup.onToggle()
  })
  await waitFor(() => expect(hook.result.current.tools.markup.active).toBe(true))
  expect(mainCleanCapture).toHaveBeenCalledWith({
    browserPageId: 'page-1',
    requestId: expect.stringMatching(/^draw-clean-/)
  })
  // A second owner would let Draw submit while Grab's screenshot still holds main's lane.
  expect(webviewReadback).not.toHaveBeenCalled()
  expect(webview.capturePage).not.toHaveBeenCalled()
})

it('client-hosted Draw gives up at its deadline while main waits for a held page load, and never opens late', async () => {
  vi.useFakeTimers()
  // Main admits the clean only once the page stops loading; a subresource holds that load.
  let finishLoad: () => void = () => {}
  mainCleanCapture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLoad = () => resolve(capturedPage)
      })
  )
  const { hook, webview } = renderClientHostedAnnotate()
  act(() => {
    hook.result.current.tools.markup.onToggle()
  })
  expect(hook.result.current.tools.markup.active).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DRAW_CAPTURE_DEADLINE_MS)
  })
  // Error and idle while the load is still held, and main retires this exact request.
  expect(hook.result.current.tools.markup.active).toBe(false)
  const requestId = mainCleanCapture.mock.calls[0]?.[0].requestId
  expect(mainCancel).toHaveBeenCalledWith({ browserPageId: 'page-1', requestId })

  // The load finishes and main's late answer arrives: Draw stays closed.
  finishLoad()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(hook.result.current.tools.markup.active).toBe(false)
  expect(webview.style).not.toHaveProperty('display', 'none')
  vi.useRealTimers()

  // On the loaded page a fresh Draw captures through main and opens.
  act(() => {
    hook.result.current.tools.markup.onToggle()
  })
  await waitFor(() => expect(webview.style).toHaveProperty('display', 'none'))
  expect(mainCleanCapture).toHaveBeenCalledTimes(2)
})
