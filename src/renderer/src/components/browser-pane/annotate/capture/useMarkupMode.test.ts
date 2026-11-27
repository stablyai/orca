// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useBrowserPageMarkupCapture } from './use-browser-page-markup-capture'
import { useLocalPageDraw } from './use-local-page-draw'
import { useGrabMode, type GrabModeState } from '../grab/useGrabMode'
import type { BrowserGuestAnnotationViewportBridge } from '../use-browser-guest-annotate-tools'
import type { BrowserGuestToolsTransport } from '../browser-guest-tools-transport'
import type { BrowserSetGrabModeResult } from '../../../../../../shared/browser/element-grab/browser-grab-types'

const page = vi.hoisted(() => ({
  captures: [] as { finish: (ok: boolean) => void; signal?: AbortSignal }[],
  errors: 0
}))
vi.mock('./markup-base-image', () => ({
  captureMarkupBaseImage: (_source: unknown, signal?: AbortSignal) =>
    new Promise((resolve, reject) =>
      page.captures.push({
        signal,
        finish: (ok) =>
          ok
            ? resolve({ dataUrl: 'data:image/png;base64,', width: 1, height: 1 })
            : reject(new Error('no capture'))
      })
    )
}))
vi.mock('sonner', () => ({ toast: { error: () => (page.errors += 1) } }))

/** A connected webview stand-in whose guest id the test can swap, as a recovered or reattached guest would. */
function fakeWebview(): {
  webview: Electron.WebviewTag
  guestId: { current: number }
  loading: { current: boolean }
} {
  const guestId = { current: 1 }
  const loading = { current: false }
  const element = Object.assign(document.createElement('div'), {
    getWebContentsId: () => guestId.current,
    isLoadingMainFrame: () => loading.current,
    getBoundingClientRect: () => ({ width: 10, height: 10 })
  })
  document.body.append(element)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Draw path reads only events, isConnected, size and the guest id.
  return { webview: element as unknown as Electron.WebviewTag, guestId, loading }
}

const finishCapture = (ok: boolean): Promise<void> =>
  act(async () => {
    page.captures.shift()!.finish(ok)
  })

function renderLocalDraw(webview: Electron.WebviewTag) {
  const webviewRef = { current: webview }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Draw path reads only invalidateDocument from the bridge.
  const bridge = { invalidateDocument: vi.fn() } as unknown as BrowserGuestAnnotationViewportBridge
  const stops: string[] = []
  const hook = renderHook(
    ({ grabState, isActive }: { grabState: GrabModeState; isActive: boolean }) => {
      const markup = useBrowserPageMarkupCapture(webviewRef, 'page-1')
      const draw = useLocalPageDraw({
        markup,
        grabState,
        stopPicker: () => stops.push('stop'),
        isActive,
        viewportBridge: bridge,
        webviewRef
      })
      return { markup, draw }
    },
    { initialProps: { grabState: 'idle' as GrabModeState, isActive: true } }
  )
  const start = (): void => act(() => void hook.result.current.draw.startMarkup())
  return { ...hook, start, stops }
}

beforeEach(() => {
  page.captures.length = 0
  page.errors = 0
})
afterEach(() => vi.unstubAllGlobals())

it('Draw stops an armed picker first; a reload, hidden pane or closed tab retires its capture silently', async () => {
  const { webview, loading } = fakeWebview()
  const draw = renderLocalDraw(webview)
  draw.rerender({ grabState: 'armed', isActive: true })
  // A page mid-load can't prove which document Draw would get, so the pick is kept and nothing is captured.
  loading.current = true
  draw.start()
  expect(draw.stops).toEqual([])
  expect(page.captures).toHaveLength(0)
  expect(page.errors).toBe(1)
  page.errors = 0
  loading.current = false
  draw.start()
  expect(draw.stops).toEqual(['stop'])
  act(() => draw.result.current.draw.viewportBridge.invalidateDocument())
  expect(page.captures[0].signal?.aborted).toBe(true)
  await finishCapture(false)

  draw.rerender({ grabState: 'idle', isActive: true })
  draw.start()
  draw.rerender({ grabState: 'idle', isActive: false })
  expect(page.captures[0].signal?.aborted).toBe(true)
  await finishCapture(true)
  expect(draw.result.current.markup.state).toBe('idle')

  draw.rerender({ grabState: 'idle', isActive: true })
  draw.start()
  const closing = page.captures[0]
  draw.unmount()
  expect(closing.signal?.aborted).toBe(true)
  await finishCapture(false)
  expect(page.errors).toBe(0)
})

it('a lost or replaced guest drops a held capture and its error, but keeps a drawing already open', async () => {
  const { webview, guestId } = fakeWebview()
  const draw = renderLocalDraw(webview)
  draw.start()
  act(() => void webview.dispatchEvent(new Event('render-process-gone')))
  expect(draw.result.current.markup.state).toBe('idle')
  await finishCapture(true)

  draw.start()
  guestId.current = 2
  await finishCapture(false)
  draw.start()
  guestId.current = 3
  await finishCapture(true)
  expect(draw.result.current.markup.state).toBe('idle')
  expect(page.errors).toBe(0)

  draw.start()
  await finishCapture(true)
  expect(draw.result.current.markup.state).toBe('drawing')
  act(() => void webview.dispatchEvent(new Event('destroyed')))
  expect(draw.result.current.markup.state).toBe('drawing')
})

it('a stale enable reply sends no second off, and a superseded one starts no pick', async () => {
  const replies: ((result: BrowserSetGrabModeResult) => void)[] = []
  const sent: string[] = []
  const transport = {
    setGrabMode: ({ enabled }: { enabled: boolean }) => {
      sent.push(enabled ? 'on' : 'off')
      return enabled
        ? new Promise((resolve) => replies.push(resolve))
        : Promise.resolve({ ok: true })
    },
    cancelGrab: async () => {
      sent.push('cancel')
      return true
    },
    awaitGrabSelection: () => {
      sent.push('await')
      return new Promise(() => {})
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: arming and cancelling use only these three calls.
  } as unknown as BrowserGuestToolsTransport
  vi.stubGlobal('api', { browser: { onGuestEscape: () => () => {} } })
  const { result } = renderHook(() => useGrabMode('page-1', transport))

  act(() => result.current.toggle())
  act(() => result.current.cancel())
  await act(async () => replies.shift()!({ ok: true }))
  act(() => result.current.toggle())
  await act(async () => replies.shift()!({ ok: true, superseded: true }))
  expect(result.current.state).toBe('idle')
  expect(sent).toEqual(['on', 'off', 'on'])
})
