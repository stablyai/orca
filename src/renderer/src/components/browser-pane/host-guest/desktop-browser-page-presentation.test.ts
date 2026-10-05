// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopBrowserViewApi,
  DesktopBrowserViewEvent,
  DesktopBrowserViewState
} from '../../../../../shared/desktop-browser-view-protocol'
import {
  registerNativeViewOcclusionElement,
  registerNativeViewWindowOcclusion
} from '@/lib/native-view-occlusion'
import { closeDesktopBrowserPage, ensureDesktopBrowserPage } from './desktop-browser-page-registry'
import {
  presentDesktopBrowserPage,
  type DesktopBrowserPagePresentation
} from './desktop-browser-page-presentation'

const cleanups: (() => void)[] = []
const pages: string[] = []
let sequence = 0
const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => ++sequence)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(async () => {
  for (const release of cleanups.splice(0).toReversed()) {
    release()
  }
  for (const id of pages.splice(0)) {
    await closeDesktopBrowserPage(id)
  }
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function fixture(configure?: (api: DesktopBrowserViewApi) => void) {
  const browserPageId = `presenter-${++sequence}`
  pages.push(browserPageId)
  const state: DesktopBrowserViewState = {
    browserPageId,
    generation: 'one',
    revision: 1,
    url: 'https://example.test/',
    title: 'Page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    loadError: null,
    zoomLevel: 0,
    focused: false
  }
  const listeners = new Set<(event: DesktopBrowserViewEvent) => void>()
  const api: DesktopBrowserViewApi = {
    create: vi.fn(async () => state),
    close: vi.fn(async () => {}),
    input: vi.fn(async () => {}),
    command: vi.fn(async () => ({ state })),
    updateLayout: vi.fn(async () => {}),
    captureViewport: vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,AA==',
      width: 800,
      height: 600
    })),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  const page = await ensureDesktopBrowserPage(api, {
    browserPageId,
    workspaceId: 'workspace',
    worktreeId: 'folder',
    sessionProfileId: null,
    url: state.url
  })
  const scroller = document.createElement('div')
  const content = document.createElement('div')
  scroller.append(content)
  document.body.append(scroller)
  const measure = vi
    .spyOn(content, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(100, -80, 800, 900))
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 60, 800, 400))
  let presentationState: DesktopBrowserPagePresentation = {
    active: true,
    inputLocked: false,
    hidden: false
  }
  const onFrame = vi.fn()
  const onMode = vi.fn()
  const onError = vi.fn()
  const options = {
    page,
    content,
    scroller,
    state: () => presentationState,
    onFrame,
    onMode,
    onError
  }
  configure?.(api)
  const presenter = presentDesktopBrowserPage(options)
  cleanups.push(presenter.dispose)
  await flush()
  return {
    ...options,
    api,
    measure,
    presenter,
    setState: (value: Partial<DesktopBrowserPagePresentation>) => {
      presentationState = { ...presentationState, ...value }
      presenter.refresh()
    }
  }
}

describe('desktop browser page presentation', () => {
  it('reapplies the latest hidden layout after an in-flight visible layout settles', async () => {
    const value = await fixture()
    value.setState({ active: false })
    await flush()
    let finishVisible: (() => void) | undefined
    vi.mocked(value.api.updateLayout).mockImplementation((layout) => {
      if (layout.visible) {
        return new Promise<void>((resolve) => {
          finishVisible = resolve
        })
      }
      return Promise.resolve()
    })
    vi.mocked(value.api.updateLayout).mockClear()

    value.setState({ active: true })
    expect(value.api.updateLayout).toHaveBeenCalledWith(expect.objectContaining({ visible: true }))
    value.setState({ active: false })
    expect(cancelAnimationFrame).toHaveBeenCalled()
    finishVisible?.()
    await flush()

    expect(value.api.updateLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false })
    )
  })

  it('keeps the full page geometry while clipping and preserves it when parked', async () => {
    const value = await fixture()
    expect(value.api.updateLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bounds: { x: 100, y: -80, width: 800, height: 900 },
        clipBounds: { x: 100, y: 60, width: 800, height: 400 },
        visible: true,
        forwardInput: false
      })
    )
    value.measure.mockReturnValue(new DOMRect())
    value.setState({ active: false })
    await flush()
    expect(value.api.updateLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bounds: { x: 100, y: -80, width: 800, height: 900 },
        visible: false,
        forwardInput: false
      })
    )
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(value.api.close).not.toHaveBeenCalled()
  })

  it('keeps uncovered page input available for overlapping nonmodal UI and blocks it for a modal', async () => {
    const value = await fixture()
    const popup = document.createElement('div')
    document.body.append(popup)
    vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(150, 70, 100, 50))
    cleanups.push(registerNativeViewOcclusionElement(popup))
    value.presenter.refresh()
    await flush()
    expect(value.api.updateLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false, forwardInput: true })
    )
    expect(value.onFrame).toHaveBeenCalledWith('data:image/png;base64,AA==')
    const unblock = registerNativeViewWindowOcclusion()
    cleanups.push(unblock)
    await flush()
    expect(value.api.updateLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false, forwardInput: false })
    )
    expect(value.onMode).toHaveBeenLastCalledWith(false)
    unblock()
    value.presenter.refresh()
    await flush()
    expect(value.api.updateLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false, forwardInput: true })
    )
  })

  it('clears forwarded input on unmount and never lets stale cleanup hide a replacement', async () => {
    const value = await fixture()
    const replacement = presentDesktopBrowserPage(value)
    cleanups.push(replacement.dispose)
    await flush()
    vi.mocked(value.api.updateLayout).mockClear()
    value.presenter.dispose()
    await flush()
    expect(value.api.updateLayout).not.toHaveBeenCalled()
    expect(replacement.isCurrent()).toBe(true)
    replacement.dispose()
    await flush()
    expect(value.api.updateLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false, forwardInput: false })
    )
    expect(value.api.close).not.toHaveBeenCalled()
  })
})

it('waits for the occluded layout to settle before requesting its first fallback', async () => {
  const popup = document.createElement('div')
  document.body.append(popup)
  vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 60, 800, 400))
  cleanups.push(registerNativeViewOcclusionElement(popup))
  let settle!: () => void
  const layout = new Promise<void>((resolve) => {
    settle = resolve
  })
  const f = await fixture((api) => {
    vi.mocked(api.updateLayout).mockReturnValueOnce(layout)
  })
  expect(f.api.updateLayout).toHaveBeenCalled()
  expect(f.api.captureViewport).not.toHaveBeenCalled()
  expect(f.onFrame).not.toHaveBeenCalled()
  settle()
  await flush()
  expect(f.api.captureViewport).toHaveBeenCalledTimes(1)
  expect(f.onFrame).toHaveBeenCalledWith('data:image/png;base64,AA==')
})
