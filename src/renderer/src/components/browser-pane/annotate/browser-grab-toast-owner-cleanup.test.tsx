// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserGrabPayload,
  BrowserExtractHoverResult
} from '../../../../../shared/browser-grab-types'
import { useBrowserPageGrabAnnotations } from './use-browser-page-grab-annotations'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import type { GrabModeHook } from './useGrabMode'

const state = vi.hoisted(() => ({
  recordFeatureInteraction: vi.fn(),
  addBrowserPageAnnotation: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (value: typeof state) => unknown) => select(state)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function makePayload(): BrowserGrabPayload {
  return {
    page: {
      sanitizedUrl: 'https://example.com',
      title: 'Example',
      viewportWidth: 1280,
      viewportHeight: 720,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      capturedAt: '2026-05-15T00:00:00.000Z'
    },
    target: {
      tagName: 'button',
      selector: 'button',
      textSnippet: 'Submit',
      htmlSnippet: '<button>Submit</button>',
      attributes: {},
      accessibility: {
        role: 'button',
        accessibleName: 'Submit',
        ariaLabel: null,
        ariaLabelledBy: null
      },
      rectViewport: { x: 0, y: 0, width: 100, height: 40 },
      rectPage: { x: 0, y: 0, width: 100, height: 40 },
      computedStyles: {
        display: 'inline-flex',
        position: 'static',
        width: '100px',
        height: '40px',
        margin: '0px',
        padding: '0px',
        color: 'rgb(0, 0, 0)',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        border: '0px none',
        borderRadius: '0px',
        fontFamily: 'Geist',
        fontSize: '14px',
        fontWeight: '400',
        lineHeight: '20px',
        textAlign: 'center',
        zIndex: 'auto'
      }
    },
    nearbyText: [],
    ancestorPath: [],
    screenshot: null
  }
}

const writes = vi.fn()
const imageWrites = vi.fn()
const extract = vi.fn()
const capture = vi.fn()
let originalApi: PropertyDescriptor | undefined
beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  writes.mockReset()
  imageWrites.mockReset()
  extract.mockReset()
  capture.mockReset()
  state.recordFeatureInteraction.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { writeClipboardText: writes, writeClipboardImage: imageWrites },
      browser: { extractHoverPayload: extract, captureSelectionScreenshot: capture }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})
function strictWrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>
}
function deferred<T>() {
  let complete: (value: T) => void = () => {
    throw new Error('Missing completion')
  }
  let fail: (error: unknown) => void = () => {
    throw new Error('Missing rejection')
  }
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  return { promise, complete, fail }
}
function mount({
  id = 'page-1',
  strict = false,
  trace = true,
  container = document.createElement('div')
} = {}) {
  const bounds = trace ? vi.spyOn(container, 'getBoundingClientRect') : undefined
  const grab: GrabModeHook = {
    state: 'armed',
    payload: null,
    error: null,
    contextMenu: false,
    toggle: vi.fn(),
    cancel: vi.fn(),
    rearm: vi.fn(),
    exit: vi.fn()
  }
  const containerRef = { current: container }
  const webviewRef = { current: null }
  const view = renderHook(
    ({ target }) =>
      useBrowserPageGrabAnnotations({
        browserTabId: id,
        toolTargetId: target,
        isActive: true,
        grab,
        containerRef,
        webviewRef,
        setBrowserOverlayViewport: vi.fn(),
        browserAnnotationsLength: 0,
        setBrowserAnnotationTrayOpen: vi.fn()
      }),
    { initialProps: { target: id }, ...(strict ? { wrapper: strictWrapper } : {}) }
  )
  return { view, bounds, reference: new WeakRef(container), grab }
}
const screenshot = {
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,Ynl0ZXM=',
  width: 100,
  height: 40
} as const
describe('browser grab toast owner', () => {
  it.each(['miss', 'reject'] as const)(
    'releases sixty-four closed shortcut %s owners',
    async (outcome) => {
      const requests = Array.from({ length: 64 }, () => deferred<BrowserExtractHoverResult>())
      let index = 0
      extract.mockImplementation(() => requests[index++].promise)
      const bounds: ReturnType<typeof mount>['bounds'][] = []
      for (let owner = 0; owner < 64; owner++) {
        const mounted = mount({ id: `page${owner}` })
        bounds.push(mounted.bounds)
        act(() => mounted.view.result.current.handleGrabActionShortcut('c'))
        mounted.view.unmount()
      }
      expect(extract.mock.calls).toEqual(
        Array.from({ length: 64 }, (_, owner) => [{ browserPageId: `page${owner}` }])
      )
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => {
        for (const request of requests) {
          if (outcome === 'miss') {
            request.complete({ ok: false, reason: 'not-ready' })
          } else {
            request.fail(new Error('Guest destroyed'))
          }
        }
        await Promise.resolve()
      })
      expect(writes).not.toHaveBeenCalled()
      expect(imageWrites).not.toHaveBeenCalled()
      expect(state.recordFeatureInteraction).not.toHaveBeenCalled()
      expect(bounds.reduce((total, bound) => total + (bound?.mock.calls.length ?? 0), 0)).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it.each(['c', 's'] as const)(
    'finishes late requested %s delivery without closed presentation',
    async (key) => {
      const request = deferred<BrowserExtractHoverResult>()
      const payload = makePayload()
      extract.mockReturnValue(request.promise)
      capture.mockResolvedValue({ ok: true, screenshot })
      const { view, bounds } = mount()
      act(() => view.result.current.handleGrabActionShortcut(key))
      view.unmount()
      await act(async () => {
        request.complete({ ok: true, payload })
        await Promise.resolve()
      })
      if (key === 'c') {
        expect(writes.mock.calls).toEqual([[formatGrabPayloadAsText(payload)]])
      } else {
        expect(capture.mock.calls).toEqual([
          [{ browserPageId: 'page-1', rect: payload.target.rectViewport }]
        ])
        expect(imageWrites.mock.calls).toEqual([[screenshot.dataUrl]])
        expect(payload.screenshot).toBe(screenshot)
      }
      expect(state.recordFeatureInteraction.mock.calls).toEqual([['browser-grab']])
      expect(bounds).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it.each(['c', 's'] as const)(
    'preserves complete live %s toast and exact two-second lifetime',
    async (key) => {
      const payload = makePayload()
      extract.mockResolvedValue({ ok: true, payload })
      capture.mockResolvedValue({ ok: true, screenshot })
      const { view, bounds, grab } = mount({ strict: true })
      await act(async () => {
        view.result.current.handleGrabActionShortcut(key)
        await Promise.resolve()
      })
      expect(writes.mock.calls).toEqual(key === 'c' ? [[formatGrabPayloadAsText(payload)]] : [])
      expect(imageWrites.mock.calls).toEqual(key === 's' ? [[screenshot.dataUrl]] : [])
      expect(state.recordFeatureInteraction.mock.calls).toEqual([['browser-grab']])
      expect(view.result.current.grabToast).toEqual({
        message: key === 'c' ? 'Copied' : 'Screenshotted',
        type: 'success',
        x: 50,
        y: 0,
        below: false,
        payload
      })
      expect(bounds).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      act(() => vi.advanceTimersByTime(1999))
      expect(view.result.current.grabToast?.type).toBe('success')
      act(() => vi.advanceTimersByTime(1))
      expect(view.result.current.grabToast).toBeNull()
      expect(grab.rearm).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it.each(['miss', 'reject', 'screenshot-reject'] as const)(
    'preserves live %s feedback and cleanup',
    async (outcome) => {
      const payload = makePayload()
      if (outcome === 'miss') {
        extract.mockResolvedValue({ ok: false, reason: 'not-ready' })
      } else if (outcome === 'reject') {
        extract.mockRejectedValue(new Error('Guest destroyed'))
      } else {
        extract.mockResolvedValue({ ok: true, payload })
        capture.mockRejectedValue(new Error('Screenshot failed'))
      }
      const { view, bounds } = mount()
      await act(async () => {
        view.result.current.handleGrabActionShortcut(outcome === 'screenshot-reject' ? 's' : 'c')
        await Promise.resolve()
      })
      expect(view.result.current.grabToast?.message).toBe(
        outcome === 'miss'
          ? 'No element hovered'
          : outcome === 'reject'
            ? 'Could not read the hovered element'
            : 'No screenshot available'
      )
      expect(view.result.current.grabToast?.type).toBe('error')
      expect(writes).not.toHaveBeenCalled()
      expect(imageWrites).not.toHaveBeenCalled()
      expect(state.recordFeatureInteraction).not.toHaveBeenCalled()
      expect(bounds).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      view.unmount()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('keeps a same-DOM replacement timer after a closed StrictMode owner settles', async () => {
    const request = deferred<BrowserExtractHoverResult>()
    const payload = makePayload()
    const container = document.createElement('div')
    extract.mockReturnValueOnce(request.promise).mockResolvedValueOnce({ ok: true, payload })
    const old = mount({ strict: true, container })
    act(() => old.view.result.current.handleGrabActionShortcut('c'))
    old.view.unmount()
    const next = mount({ id: 'page-2', strict: true, container })
    await act(async () => {
      next.view.result.current.handleGrabActionShortcut('c')
      await Promise.resolve()
    })
    const replacementToast = next.view.result.current.grabToast
    await act(async () => {
      request.complete({ ok: true, payload })
      await Promise.resolve()
    })
    expect(writes.mock.calls).toEqual([
      [formatGrabPayloadAsText(payload)],
      [formatGrabPayloadAsText(payload)]
    ])
    expect(state.recordFeatureInteraction).toHaveBeenCalledTimes(2)
    expect(next.view.result.current.grabToast).toBe(replacementToast)
    expect(next.bounds).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(2000))
    expect(next.view.result.current.grabToast).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['clipboard', 'interaction'] as const)(
    'honors reentrant cleanup during %s delivery',
    async (point) => {
      const payload = makePayload()
      extract.mockResolvedValue({ ok: true, payload })
      const { view, bounds } = mount()
      if (point === 'clipboard') {
        writes.mockImplementationOnce(() => view.unmount())
      } else {
        state.recordFeatureInteraction.mockImplementationOnce(() => view.unmount())
      }
      await act(async () => {
        view.result.current.handleGrabActionShortcut('c')
        await Promise.resolve()
      })
      expect(writes.mock.calls).toEqual([[formatGrabPayloadAsText(payload)]])
      expect(state.recordFeatureInteraction.mock.calls).toEqual([['browser-grab']])
      expect(bounds).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('preserves latest target reads and screenshot completion after cleanup', async () => {
    const extraction = deferred<BrowserExtractHoverResult>()
    const image = deferred<{ ok: true; screenshot: typeof screenshot }>()
    const payload = makePayload()
    extract.mockReturnValue(extraction.promise)
    capture.mockReturnValue(image.promise)
    const { view, bounds } = mount()
    act(() => view.result.current.handleGrabActionShortcut('s'))
    view.rerender({ target: 'recovered-target' })
    await act(async () => {
      extraction.complete({ ok: true, payload })
      await Promise.resolve()
    })
    expect(extract.mock.calls).toEqual([[{ browserPageId: 'page-1' }]])
    expect(capture.mock.calls).toEqual([
      [{ browserPageId: 'recovered-target', rect: payload.target.rectViewport }]
    ])
    view.unmount()
    await act(async () => {
      image.complete({ ok: true, screenshot })
      await Promise.resolve()
    })
    expect(imageWrites.mock.calls).toEqual([[screenshot.dataUrl]])
    expect(state.recordFeatureInteraction.mock.calls).toEqual([['browser-grab']])
    expect(payload.screenshot).toBe(screenshot)
    expect(bounds).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('releases closed container references after settled shortcuts', async () => {
    const request = deferred<BrowserExtractHoverResult>()
    extract.mockReturnValue(request.promise)
    function closeOwners() {
      const references: WeakRef<HTMLElement>[] = []
      for (let owner = 0; owner < 64; owner++) {
        const { view, reference } = mount({ id: `page${owner}`, trace: false })
        references.push(reference)
        act(() => view.result.current.handleGrabActionShortcut('c'))
        view.unmount()
      }
      return references
    }
    const references = closeOwners()
    cleanup()
    await act(async () => {
      request.complete({ ok: false, reason: 'not-ready' })
      await Promise.resolve()
    })
    expect(extract).toHaveBeenCalledTimes(64)
    expect(writes).not.toHaveBeenCalled()
    if (typeof globalThis.gc !== 'function') {
      throw new Error('The runner must enable forced GC')
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
    globalThis.gc()
    expect(references.filter((reference) => reference.deref()).length).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
